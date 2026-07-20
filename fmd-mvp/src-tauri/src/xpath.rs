//! Minimal HTML XPath engine for the LeerCapitulo.lua subset (pure Rust / scraper).

use regex::Regex;
use scraper::{ElementRef, Html, Node};
use std::sync::OnceLock;

#[derive(Debug, Clone)]
pub enum DomNode {
    Elem {
        tag: String,
        attrs: Vec<(String, String)>,
        children: Vec<DomNode>,
    },
    Text(String),
}

impl DomNode {
    pub fn attr(&self, name: &str) -> Option<&str> {
        match self {
            DomNode::Elem { attrs, .. } => attrs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v.as_str()),
            _ => None,
        }
    }

    pub fn all_text(&self) -> String {
        let mut out = String::new();
        self.collect_text(&mut out);
        collapse_ws(&out)
    }

    fn collect_text(&self, out: &mut String) {
        match self {
            DomNode::Text(t) => out.push_str(t),
            DomNode::Elem { children, .. } => {
                for c in children {
                    c.collect_text(out);
                }
            }
        }
    }
}

pub struct TxQuery {
    roots: Vec<DomNode>,
}

impl TxQuery {
    pub fn parse(html: &str) -> Self {
        let document = Html::parse_document(html);
        let roots = document
            .root_element()
            .children()
            .filter_map(to_dom)
            .collect();
        Self { roots }
    }

    pub fn xpath_nodes(&self, expr: &str) -> Vec<DomNode> {
        if let Some(nodes) = eval_paren_last(&self.roots, expr, |r, e| {
            let (path, _terminal) = split_terminal(e);
            eval(r, &path)
        }) {
            return nodes;
        }
        let (path, terminal) = split_terminal(expr);
        let nodes = eval(&self.roots, &path);
        match terminal {
            Terminal::Attr(_) | Terminal::Text => nodes,
            Terminal::None => nodes,
        }
    }

    pub fn xpath_string(&self, expr: &str) -> String {
        if let Some(s) = eval_paren_last(&self.roots, expr, |r, e| {
            let q = TxQuery {
                roots: r.to_vec(),
            };
            q.xpath_string(e)
        }) {
            return s;
        }
        if let Some(s) = eval_following_sibling_text(&self.roots, expr) {
            return s;
        }
        let (path, terminal) = split_terminal(expr);
        let nodes = eval(&self.roots, &path);
        match terminal {
            Terminal::Attr(name) => nodes
                .first()
                .and_then(|n| n.attr(&name).map(|s| s.to_string()))
                .unwrap_or_default(),
            Terminal::Text | Terminal::None => nodes
                .first()
                .map(|n| n.all_text())
                .unwrap_or_default(),
        }
    }

    pub fn xpath_string_all(&self, expr: &str) -> String {
        self.xpath_string_all_values(expr).join(", ")
    }

    pub fn xpath_string_all_values(&self, expr: &str) -> Vec<String> {
        self.xpath_string_all_values_on(&self.roots, expr)
    }

    pub fn xpath_string_ctx(&self, expr: &str, ctx: &DomNode) -> String {
        let roots = [ctx.clone()];
        if let Some(s) = eval_following_sibling_text(&roots, expr) {
            return s;
        }
        let (path, terminal) = split_terminal(expr);
        let nodes = eval(&roots, &path);
        match terminal {
            Terminal::Attr(name) => nodes
                .first()
                .and_then(|n| n.attr(&name).map(|s| s.to_string()))
                .unwrap_or_default(),
            Terminal::Text | Terminal::None => nodes
                .first()
                .map(|n| n.all_text())
                .unwrap_or_default(),
        }
    }

    pub fn xpath_nodes_ctx(&self, expr: &str, ctx: &DomNode) -> Vec<DomNode> {
        let roots = [ctx.clone()];
        let (path, _terminal) = split_terminal(expr);
        eval(&roots, &path)
    }

    pub fn xpath_string_all_values_on(&self, roots: &[DomNode], expr: &str) -> Vec<String> {
        if let Some(vals) = eval_paren_last(roots, expr, |r, e| {
            Self::xpath_string_all_values_on_inner(r, e)
        }) {
            return vals;
        }
        Self::xpath_string_all_values_on_inner(roots, expr)
    }

    fn xpath_string_all_values_on_inner(roots: &[DomNode], expr: &str) -> Vec<String> {
        let (path, terminal) = split_terminal(expr);
        let nodes = eval(roots, &path);
        match terminal {
            Terminal::Attr(name) => nodes
                .iter()
                .filter_map(|n| n.attr(&name).map(|s| s.to_string()))
                .collect(),
            Terminal::Text | Terminal::None => nodes
                .iter()
                .map(|n| n.all_text())
                .filter(|s| !s.is_empty())
                .collect(),
        }
    }

    /// Collect (href, text) for each node matching `expr` (typically `//…/a`).
    pub fn xpath_href_all(&self, expr: &str) -> Vec<(String, String)> {
        let nodes = self.xpath_nodes(expr);
        nodes
            .into_iter()
            .filter_map(|n| {
                let href = n.attr("href")?.to_string();
                let name = n.all_text();
                Some((href, name))
            })
            .collect()
    }

    /// Like HREFAll but names come from `@title` (fallback to text).
    pub fn xpath_href_title_all(&self, expr: &str) -> Vec<(String, String)> {
        let nodes = self.xpath_nodes(expr);
        nodes
            .into_iter()
            .filter_map(|n| {
                let href = n.attr("href")?.to_string();
                let name = n
                    .attr("title")
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| n.all_text());
                Some((href, name))
            })
            .collect()
    }
}

impl DomNode {
    pub fn to_string_value(&self) -> String {
        match self {
            DomNode::Text(t) => collapse_ws(t),
            DomNode::Elem { .. } => self.all_text(),
        }
    }
}

/// Handle `(//…path…)[last()]/rest` used by NiAdd PageContainerLinks.
fn eval_paren_last<R>(
    roots: &[DomNode],
    expr: &str,
    then: impl FnOnce(&[DomNode], &str) -> R,
) -> Option<R> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"^\((.+)\)\[last\(\)\]/(.*)$"#).unwrap());
    let caps = re.captures(expr.trim())?;
    let inner = caps.get(1)?.as_str();
    let rest = caps.get(2)?.as_str();
    let nodes = eval(roots, inner);
    let last = nodes.last()?.clone();
    Some(then(&[last], rest))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paren_last_option_values() {
        let html = r#"
        <select class="sl-page"><option value="/a/1">1</option></select>
        <select class="sl-page">
          <option value="/b/1">1</option>
          <option value="/b/2">2</option>
        </select>
        "#;
        let q = TxQuery::parse(html);
        let vals = q.xpath_string_all_values(
            "(//select[@class=\"sl-page\"])[last()]/option/@value",
        );
        assert_eq!(vals, vec!["/b/1".to_string(), "/b/2".to_string()]);
    }
}

fn to_dom(node: ego_tree::NodeRef<'_, Node>) -> Option<DomNode> {
    match node.value() {
        Node::Text(t) => {
            let s = t.to_string();
            if s.is_empty() {
                None
            } else {
                Some(DomNode::Text(s))
            }
        }
        Node::Element(_) => {
            let el = ElementRef::wrap(node)?;
            let tag = el.value().name().to_string();
            let attrs = el
                .value()
                .attrs()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
            let children = el.children().filter_map(to_dom).collect();
            Some(DomNode::Elem {
                tag,
                attrs,
                children,
            })
        }
        _ => None,
    }
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

enum Terminal {
    None,
    Attr(String),
    Text,
}

fn split_terminal(expr: &str) -> (String, Terminal) {
    let expr = expr.trim();
    if let Some(rest) = expr.strip_suffix("/text()") {
        return (rest.to_string(), Terminal::Text);
    }
    if let Some(idx) = expr.rfind("/@") {
        return (
            expr[..idx].to_string(),
            Terminal::Attr(expr[idx + 2..].to_string()),
        );
    }
    (expr.to_string(), Terminal::None)
}

#[derive(Clone)]
enum Pred {
    AttrEq(String, String),
    AttrContains(String, String),
    TextContains(String),
}

#[derive(Clone)]
struct Step {
    descendant: bool,
    name: String,
    preds: Vec<Pred>,
}

fn parse_steps(expr: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut rest = expr.trim();
    while !rest.is_empty() {
        let descendant;
        if rest.starts_with("//") {
            descendant = true;
            rest = &rest[2..];
        } else if rest.starts_with('/') {
            descendant = false;
            rest = &rest[1..];
        } else if steps.is_empty() {
            descendant = true;
        } else {
            break;
        }

        let name_end = rest
            .char_indices()
            .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '_' && *c != '-' && *c != '*')
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        if name_end == 0 {
            break;
        }
        let name = rest[..name_end].to_string();
        rest = &rest[name_end..];

        let mut preds = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = find_closing_bracket(rest) else {
                break;
            };
            if let Some(p) = parse_pred(&rest[1..end]) {
                preds.push(p);
            }
            rest = &rest[end + 1..];
        }

        steps.push(Step {
            descendant,
            name,
            preds,
        });
    }
    steps
}

fn find_closing_bracket(s: &str) -> Option<usize> {
    let mut depth = 0usize;
    for (i, b) in s.bytes().enumerate() {
        match b {
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

fn parse_pred(inner: &str) -> Option<Pred> {
    let inner = inner.trim();
    static EQ: OnceLock<Regex> = OnceLock::new();
    static AC: OnceLock<Regex> = OnceLock::new();
    static TC: OnceLock<Regex> = OnceLock::new();

    let eq = EQ.get_or_init(|| {
        Regex::new(r#"^@([a-zA-Z0-9_\-:]+)\s*=\s*['"]([^'"]*)['"]$"#).unwrap()
    });
    if let Some(c) = eq.captures(inner) {
        return Some(Pred::AttrEq(
            c[1].to_string(),
            c[2].to_string(),
        ));
    }
    let ac = AC.get_or_init(|| {
        Regex::new(r#"^contains\(@([a-zA-Z0-9_\-:]+)\s*,\s*['"]([^'"]*)['"]\)$"#).unwrap()
    });
    if let Some(c) = ac.captures(inner) {
        return Some(Pred::AttrContains(
            c[1].to_string(),
            c[2].to_string(),
        ));
    }
    let tc = TC.get_or_init(|| {
        Regex::new(r#"^contains\(\.\s*,\s*['"]([^'"]*)['"]\)$"#).unwrap()
    });
    if let Some(c) = tc.captures(inner) {
        return Some(Pred::TextContains(c[1].to_string()));
    }
    None
}

fn match_pred(node: &DomNode, pred: &Pred) -> bool {
    match pred {
        Pred::AttrEq(k, v) => node.attr(k) == Some(v.as_str()),
        Pred::AttrContains(k, v) => node.attr(k).is_some_and(|a| a.contains(v)),
        Pred::TextContains(v) => node.all_text().contains(v.as_str()),
    }
}

fn match_name(node: &DomNode, name: &str) -> bool {
    match node {
        DomNode::Elem { tag, .. } => name == "*" || tag.eq_ignore_ascii_case(name),
        DomNode::Text(_) => false,
    }
}

fn eval(roots: &[DomNode], expr: &str) -> Vec<DomNode> {
    let steps = parse_steps(expr);
    let mut current: Vec<DomNode> = roots.to_vec();
    for step in steps {
        let mut next = Vec::new();
        if step.descendant {
            for n in &current {
                collect_desc(n, &step, &mut next);
            }
        } else {
            for n in &current {
                if let DomNode::Elem { children, .. } = n {
                    for c in children {
                        if match_name(c, &step.name)
                            && step.preds.iter().all(|p| match_pred(c, p))
                        {
                            next.push(c.clone());
                        }
                    }
                }
            }
        }
        current = next;
    }
    current
}

fn collect_desc(node: &DomNode, step: &Step, out: &mut Vec<DomNode>) {
    if match_name(node, &step.name) && step.preds.iter().all(|p| match_pred(node, p)) {
        out.push(node.clone());
    }
    if let DomNode::Elem { children, .. } = node {
        for c in children {
            collect_desc(c, step, out);
        }
    }
}

fn eval_following_sibling_text(roots: &[DomNode], expr: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(.*)/following-sibling::text\(\)\[(\d+)\]\s*$").unwrap()
    });
    let caps = re.captures(expr.trim())?;
    let path = caps.get(1)?.as_str();
    let index: usize = caps.get(2)?.as_str().parse().ok()?;
    let targets = eval(roots, path);
    let target = targets.first()?;
    find_following_text(roots, target, index)
}

fn same_elem(a: &DomNode, b: &DomNode) -> bool {
    match (a, b) {
        (
            DomNode::Elem {
                tag: t1,
                attrs: a1,
                children: c1,
            },
            DomNode::Elem {
                tag: t2,
                attrs: a2,
                children: c2,
            },
        ) => t1 == t2 && a1 == a2 && c1.len() == c2.len() && a.all_text() == b.all_text(),
        _ => false,
    }
}

fn find_following_text(nodes: &[DomNode], target: &DomNode, index: usize) -> Option<String> {
    for node in nodes {
        if let DomNode::Elem { children, .. } = node {
            for (i, child) in children.iter().enumerate() {
                if same_elem(child, target) {
                    let mut count = 0usize;
                    for sib in children.iter().skip(i + 1) {
                        if let DomNode::Text(t) = sib {
                            let trimmed = t.trim();
                            if !trimmed.is_empty() {
                                count += 1;
                                if count == index {
                                    return Some(trimmed.to_string());
                                }
                            }
                        }
                    }
                }
                if let Some(r) = find_following_text(
                    match child {
                        DomNode::Elem { children, .. } => children.as_slice(),
                        _ => &[],
                    },
                    target,
                    index,
                ) {
                    return Some(r);
                }
            }
        }
    }
    None
}
