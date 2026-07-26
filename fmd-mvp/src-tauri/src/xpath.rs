//! Minimal HTML XPath engine aligned with FMD2 TXQuery usage in Lua modules.
//!
//! Supported (HTML subset): `//` `/` `.//` `./` `*` `@attr` `/@attr` `/text()`,
//! predicates `@a='…'` `contains(@a,'…')` `contains(.,'…')` `starts-with(.,'…')`
//! `text()='…'` `self::tag` `and`/`or`, positional `[n]` `[last()]` `[last()-n]`,
//! `(path)[n|last()|last()-n]/rest`, `following-sibling::text()[n]`,
//! union `|`, mid-path `/substring-after(.,…)` `/substring-before(.,…)` `/normalize-space(.)`.
//!
//! JSON (`json(*)`, `parse-json`, `?*`) lives in `lua_host::json_xpath`, not here.

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

    /// Raw descendant text without whitespace collapse (needed for JSON in `<script>`).
    pub fn raw_text(&self) -> String {
        let mut out = String::new();
        self.collect_text(&mut out);
        out
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

    /// XPath `/text()` — direct text children only (excludes nested elements like `<h3>`).
    pub fn direct_text(&self) -> String {
        match self {
            DomNode::Text(t) => collapse_ws(t),
            DomNode::Elem { children, .. } => {
                let mut out = String::new();
                for c in children {
                    if let DomNode::Text(t) = c {
                        out.push_str(t);
                    }
                }
                collapse_ws(&out)
            }
        }
    }

    pub fn to_string_value(&self) -> String {
        match self {
            DomNode::Text(t) => collapse_ws(t),
            DomNode::Elem { .. } => self.all_text(),
        }
    }
}

pub struct TxQuery {
    roots: Vec<DomNode>,
    source: String,
}

impl TxQuery {
    pub fn parse(html: &str) -> Self {
        let document = Html::parse_document(html);
        let roots = document
            .root_element()
            .children()
            .filter_map(to_dom)
            .collect();
        Self {
            roots,
            source: html.to_string(),
        }
    }

    /// Original input string (needed for `json(*)` on raw JSON API bodies).
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Concatenated raw text of the DOM (fallback when source parse fails).
    pub fn raw_document_text(&self) -> String {
        let mut out = String::new();
        for n in &self.roots {
            out.push_str(&n.raw_text());
        }
        out
    }

    pub fn xpath_nodes(&self, expr: &str) -> Vec<DomNode> {
        eval_expr(&self.roots, expr.trim())
    }

    pub fn xpath_string(&self, expr: &str) -> String {
        let expr = expr.trim();
        if let Some(s) = eval_string_join_html(&self.roots, expr) {
            return s;
        }
        if let Some(s) = eval_mid_path_string(&self.roots, expr) {
            return s;
        }
        if let Some(s) = eval_bang_string(&self.roots, expr) {
            return s;
        }
        if let Some(s) = eval_following_sibling_text(&self.roots, expr) {
            return s;
        }
        let (nodes, terminal) = eval_expr_term(&self.roots, expr);
        string_of_nodes(&nodes, terminal)
    }

    pub fn xpath_string_all(&self, expr: &str) -> String {
        self.xpath_string_all_values(expr).join(", ")
    }

    pub fn xpath_string_all_values(&self, expr: &str) -> Vec<String> {
        self.xpath_string_all_values_on(&self.roots, expr)
    }

    pub fn xpath_string_ctx(&self, expr: &str, ctx: &DomNode) -> String {
        let roots = [ctx.clone()];
        let expr = expr.trim();
        if let Some(s) = eval_string_join_html(&roots, expr) {
            return s;
        }
        if let Some(s) = eval_mid_path_string(&roots, expr) {
            return s;
        }
        if let Some(s) = eval_bang_string(&roots, expr) {
            return s;
        }
        if let Some(s) = eval_following_sibling_text(&roots, expr) {
            return s;
        }
        let (nodes, terminal) = eval_expr_term(&roots, expr);
        string_of_nodes(&nodes, terminal)
    }

    pub fn xpath_nodes_ctx(&self, expr: &str, ctx: &DomNode) -> Vec<DomNode> {
        eval_expr(&[ctx.clone()], expr.trim())
    }

    pub fn xpath_string_all_values_on(&self, roots: &[DomNode], expr: &str) -> Vec<String> {
        let expr = expr.trim();
        if let Some(s) = eval_string_join_html(roots, expr) {
            return if s.is_empty() { vec![] } else { vec![s] };
        }
        if let Some(s) = eval_mid_path_string(roots, expr) {
            return if s.is_empty() { vec![] } else { vec![s] };
        }
        if let Some(s) = eval_bang_string(roots, expr) {
            return if s.is_empty() { vec![] } else { vec![s] };
        }
        let (nodes, terminal) = eval_expr_term(roots, expr);
        strings_of_nodes(&nodes, terminal)
    }

    /// Collect (href, text) for each node matching `expr` (typically `//…/a`).
    pub fn xpath_href_all(&self, expr: &str) -> Vec<(String, String)> {
        self.xpath_nodes(expr)
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
        self.xpath_nodes(expr)
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

fn string_of_nodes(nodes: &[DomNode], terminal: Terminal) -> String {
    match terminal {
        Terminal::Attr(name) => nodes
            .first()
            .and_then(|n| n.attr(&name).map(|s| s.to_string()))
            .unwrap_or_default(),
        Terminal::Text => nodes.first().map(|n| n.direct_text()).unwrap_or_default(),
        Terminal::None => nodes
            .first()
            .map(|n| n.all_text())
            .unwrap_or_default(),
    }
}

fn strings_of_nodes(nodes: &[DomNode], terminal: Terminal) -> Vec<String> {
    match terminal {
        Terminal::Attr(name) => nodes
            .iter()
            .filter_map(|n| n.attr(&name).map(|s| s.to_string()))
            .collect(),
        Terminal::Text => nodes
            .iter()
            .map(|n| n.direct_text())
            .filter(|s| !s.is_empty())
            .collect(),
        Terminal::None => nodes
            .iter()
            .map(|n| n.all_text())
            .filter(|s| !s.is_empty())
            .collect(),
    }
}

/// Nodes + how to stringify them (attr / text / element string-value).
fn eval_expr_term(roots: &[DomNode], expr: &str) -> (Vec<DomNode>, Terminal) {
    let expr = expr.trim();
    if expr.is_empty() {
        return (Vec::new(), Terminal::None);
    }
    let parts = split_top_level(expr, '|');
    if parts.len() > 1 {
        let mut out = Vec::new();
        let mut term = Terminal::None;
        for (i, p) in parts.iter().enumerate() {
            let (nodes, t) = eval_expr_term(roots, p.trim());
            if i == 0 {
                term = t;
            }
            out.extend(nodes);
        }
        return (out, term);
    }
    if let Some(v) = eval_paren_positional_term(roots, expr) {
        return v;
    }
    let (path, terminal) = split_terminal(expr);
    (eval_path(roots, &path), terminal)
}

/// Evaluate full expression including `|` unions and `(…)[pos]/rest`.
fn eval_expr(roots: &[DomNode], expr: &str) -> Vec<DomNode> {
    eval_expr_term(roots, expr).0
}

/// `(//…)[last()|last()-n|n]/rest` or without `/rest`.
fn eval_paren_positional_term(
    roots: &[DomNode],
    expr: &str,
) -> Option<(Vec<DomNode>, Terminal)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r#"^\((.+)\)\[(last\(\)-\d+|last\(\)|\d+)\](?:/(.*))?$"#).unwrap()
    });
    let caps = re.captures(expr.trim())?;
    let inner = caps.get(1)?.as_str();
    let pos = parse_position(caps.get(2)?.as_str())?;
    let selected = apply_position(eval_expr(roots, inner), Some(&pos));
    let rest = caps.get(3).map(|m| m.as_str()).unwrap_or("").trim();
    if rest.is_empty() {
        return Some((selected, Terminal::None));
    }
    Some(eval_expr_term(&selected, rest))
}

fn eval_mid_path_string(roots: &[DomNode], expr: &str) -> Option<String> {
    static AFTER: OnceLock<Regex> = OnceLock::new();
    static BEFORE: OnceLock<Regex> = OnceLock::new();
    static NORM: OnceLock<Regex> = OnceLock::new();
    static REPL: OnceLock<Regex> = OnceLock::new();
    static RESURI: OnceLock<Regex> = OnceLock::new();
    static CONCAT: OnceLock<Regex> = OnceLock::new();

    let after = AFTER.get_or_init(|| {
        Regex::new(r#"^(.*)/substring-after\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*\)$"#).unwrap()
    });
    let before = BEFORE.get_or_init(|| {
        Regex::new(r#"^(.*)/substring-before\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*\)$"#).unwrap()
    });
    let norm =
        NORM.get_or_init(|| Regex::new(r#"^(.*)/normalize-space\(\s*\.\s*\)$"#).unwrap());
    let repl = REPL.get_or_init(|| {
        Regex::new(
            r#"^(.*)/replace\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)$"#,
        )
        .unwrap()
    });
    let resuri = RESURI.get_or_init(|| {
        Regex::new(r#"^(.*)/resolve-uri\(\s*@([a-zA-Z0-9_\-:]+)\s*\)$"#).unwrap()
    });
    let concat_re = CONCAT.get_or_init(|| {
        Regex::new(r#"^(.*)/concat\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*\)$"#).unwrap()
    });

    if let Some(c) = after.captures(expr) {
        let path = c.get(1)?.as_str();
        let (nodes, terminal) = eval_expr_term(roots, path);
        let base = string_of_nodes(&nodes, terminal);
        let needle = c.get(2)?.as_str();
        return Some(substring_after(&base, needle));
    }
    if let Some(c) = before.captures(expr) {
        let path = c.get(1)?.as_str();
        let (nodes, terminal) = eval_expr_term(roots, path);
        let base = string_of_nodes(&nodes, terminal);
        let needle = c.get(2)?.as_str();
        return Some(substring_before(&base, needle));
    }
    if let Some(c) = norm.captures(expr) {
        let path = c.get(1)?.as_str();
        let (nodes, terminal) = eval_expr_term(roots, path);
        let base = string_of_nodes(&nodes, terminal);
        return Some(collapse_ws(&base));
    }
    if let Some(c) = repl.captures(expr) {
        let path = c.get(1)?.as_str();
        let (nodes, terminal) = eval_expr_term(roots, path);
        let base = string_of_nodes(&nodes, terminal);
        let pat = c.get(2)?.as_str();
        let repl_s = c.get(3)?.as_str();
        return Some(base.replace(pat, repl_s));
    }
    if let Some(c) = concat_re.captures(expr) {
        let path = c.get(1)?.as_str();
        let (nodes, terminal) = eval_expr_term(roots, path);
        let base = string_of_nodes(&nodes, terminal);
        let suffix = c.get(2)?.as_str();
        return Some(format!("{base}{suffix}"));
    }
    if let Some(c) = resuri.captures(expr) {
        let path = c.get(1)?.as_str();
        let attr = c.get(2)?.as_str();
        let nodes = eval_expr(roots, path);
        let href = nodes
            .first()
            .and_then(|n| n.attr(attr).map(|s| s.to_string()))
            .unwrap_or_default();
        let base = document_base_href(roots);
        return Some(resolve_uri(&href, &base));
    }
    None
}

fn eval_string_join_html(roots: &[DomNode], expr: &str) -> Option<String> {
    let rest = expr.strip_prefix("string-join(")?;
    let end = find_closing_paren_str(rest)?;
    if !rest[end + 1..].trim().is_empty() {
        return None;
    }
    let inside = &rest[..end];
    let parts = split_top_level_str(inside, ",");
    if parts.is_empty() {
        return None;
    }
    let sep = if parts.len() >= 2 {
        let raw = parts.last().unwrap().trim();
        unquote_str(raw).unwrap_or_else(|| raw.to_string())
    } else {
        ", ".to_string()
    };
    let seq = if parts.len() >= 2 {
        parts[..parts.len() - 1].join(",")
    } else {
        parts[0].to_string()
    };
    let seq = seq.trim();
    // Evaluate union / paths → all string values (keep outer parens for `(…)[n]|…`).
    let (nodes, terminal) = eval_expr_term(roots, seq);
    let vals = strings_of_nodes(&nodes, terminal);
    Some(vals.join(&sep))
}

fn eval_bang_string(roots: &[DomNode], expr: &str) -> Option<String> {
    if !expr.contains('!') || expr.contains("!=") {
        return None;
    }
    // LHS!RHS — map operator (subset): for each LHS node, eval RHS relative, take first string.
    let parts = split_top_level_str(expr, "!");
    if parts.len() != 2 {
        return None;
    }
    let lhs = parts[0].trim();
    let rhs = parts[1].trim();
    if lhs.is_empty() || rhs.is_empty() {
        return None;
    }
    let nodes = eval_expr(roots, lhs);
    for n in &nodes {
        let s = {
            let (ns, term) = eval_expr_term(std::slice::from_ref(n), rhs);
            string_of_nodes(&ns, term)
        };
        if !s.is_empty() {
            return Some(s);
        }
    }
    Some(String::new())
}

fn document_base_href(roots: &[DomNode]) -> String {
    // <base href="…"> if present
    let nodes = eval_expr(roots, "//base");
    nodes
        .first()
        .and_then(|n| n.attr("href").map(|s| s.to_string()))
        .unwrap_or_default()
}

fn resolve_uri(href: &str, base: &str) -> String {
    let href = href.trim();
    if href.is_empty() {
        return String::new();
    }
    if href.starts_with("http://")
        || href.starts_with("https://")
        || href.starts_with("data:")
        || href.starts_with("//")
    {
        return href.to_string();
    }
    if base.is_empty() {
        return href.to_string();
    }
    if let Ok(base_u) = url::Url::parse(base) {
        if let Ok(joined) = base_u.join(href) {
            return joined.to_string();
        }
    }
    if href.starts_with('/') {
        // Keep path-absolute as-is when base is not a full URL.
        return href.to_string();
    }
    let base = base.trim_end_matches('/');
    format!("{base}/{href}")
}

fn find_closing_paren_str(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        if let Some(q) = in_quote {
            if c == q {
                in_quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => in_quote = Some(c),
            '(' => depth += 1,
            ')' => {
                if depth == 0 {
                    return Some(i);
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    None
}

fn unquote_str(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"') || (b[0] == b'\'' && b[s.len() - 1] == b'\'') {
            return Some(s[1..s.len() - 1].to_string());
        }
    }
    None
}

fn substring_after(s: &str, needle: &str) -> String {
    if needle.is_empty() {
        return s.to_string();
    }
    s.split_once(needle)
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_default()
}

fn substring_before(s: &str, needle: &str) -> String {
    if needle.is_empty() {
        return String::new();
    }
    s.split_once(needle)
        .map(|(pre, _)| pre.to_string())
        .unwrap_or_default()
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

    #[test]
    fn paren_index_h1() {
        let html = r#"<h1>first</h1><h1>second</h1>"#;
        let q = TxQuery::parse(html);
        assert_eq!(q.xpath_string("(//h1)[1]"), "first");
        assert_eq!(q.xpath_string("(//h1)[2]"), "second");
        assert_eq!(q.xpath_string("(//h1)[last()]"), "second");
    }

    #[test]
    fn foolslide_summary_text_eq_or() {
        let html = "<html><body><div class=\"info\"><b>Author</b>: Alice<br/><b>Artist</b>: Bob<br/><b>Descripción</b>: Una sinopsis de prueba bastante larga.<br/></div></body></html>";
        let q = TxQuery::parse(html);

        let authors = q.xpath_string(
            r#"//div[@class="info"]//b[text()="Author"]/following-sibling::text()[1]"#,
        );
        assert!(authors.contains("Alice"), "got authors={authors:?}");

        let summary = q.xpath_string(
            r#"//div[@class="info"]//b[text()="Synopsis" or text()="Descripción"]/following-sibling::text()[1]"#,
        );
        assert!(
            summary.contains("sinopsis de prueba"),
            "got summary={summary:?}"
        );
    }

    #[test]
    fn mangaoni_summary_direct_text_excludes_h3() {
        let html = r#"
        <div id="sinopsis">
        <h3>Sinopsis</h3>
         El mundo no es perfecto. Aprender a lidiar con sus defectos.
        </div>
        "#;
        let q = TxQuery::parse(html);
        let summary = q.xpath_string(r#"//div[@id="sinopsis"]/text()"#);
        assert!(
            summary.contains("El mundo no es perfecto"),
            "got summary={summary:?}"
        );
        assert!(
            !summary.to_lowercase().starts_with("sinopsis"),
            "must not include <h3> via all_text; got {summary:?}"
        );
    }

    #[test]
    fn positional_child_index() {
        // 18Kami: div[4]/a/@href
        let html = r#"
        <div class="img_above">
          <div>1</div><div>2</div><div>3</div>
          <div><a href="/manga/x">Title</a></div>
        </div>
        "#;
        let q = TxQuery::parse(html);
        let href = q.xpath_string(r#"//div[@class="img_above"]/div[4]/a/@href"#);
        assert_eq!(href, "/manga/x");
    }

    #[test]
    fn last_minus_pagination() {
        let html = r#"
        <ul class="pagination">
          <li><a>1</a></li>
          <li><a>2</a></li>
          <li><a>99</a></li>
          <li><a>next</a></li>
        </ul>
        "#;
        let q = TxQuery::parse(html);
        let n = q.xpath_string(r#"//ul[@class="pagination"]/li[last()-1]/a"#);
        assert_eq!(n, "99");
    }

    #[test]
    fn and_predicate_contains_text() {
        let html = r#"
        <div class="p-t-5 p-b-5">Author: <a href="/a">Bob</a></div>
        <div class="p-t-5 p-b-5">Other: <a href="/b">X</a></div>
        "#;
        let q = TxQuery::parse(html);
        let authors = q.xpath_string_all(
            r#"//div[@class="p-t-5 p-b-5" and contains(., "Author")]//a"#,
        );
        assert!(authors.contains("Bob"), "got {authors:?}");
        assert!(!authors.contains("/b"));
    }

    #[test]
    fn starts_with_predicate() {
        let html = r#"<p>Tình trạng: Ongoing</p><p>Other: x</p>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(r#"//p[starts-with(.,"Tình trạng:")]"#);
        assert!(s.contains("Ongoing"), "got {s:?}");
    }

    #[test]
    fn union_pipe() {
        let html = r#"<div class="info"><h1>A</h1></div><h1 class="tag_info"><span>B</span></h1>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(r#"//div[@class="info"]/h1|//h1[@class="tag_info"]/span"#);
        assert_eq!(s, "A");
        let all = q.xpath_string_all_values(
            r#"//div[@class="info"]/h1|//h1[@class="tag_info"]/span"#,
        );
        assert_eq!(all, vec!["A".to_string(), "B".to_string()]);
    }

    #[test]
    fn substring_after_mid_path() {
        let html = r#"<div class="p-t-5 p-b-5">description：Hello world</div>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(
            r#"(//div[@class="p-t-5 p-b-5" and contains(., "description")])[1]/substring-after(., "：")"#,
        );
        assert_eq!(s, "Hello world");
    }

    #[test]
    fn self_axis_or() {
        let html = r#"
        <div class="post-title"><h3><a href="/1">One</a></h3></div>
        <div class="post-title"><h2><a href="/2">Two</a></h2></div>
        "#;
        let q = TxQuery::parse(html);
        let pairs = q.xpath_href_all(
            r#"//div[contains(@class, "post-title")]/*[self::h3 or self::h2]/a"#,
        );
        assert_eq!(pairs.len(), 2);
        assert_eq!(pairs[0].0, "/1");
        assert_eq!(pairs[1].1, "Two");
    }

    #[test]
    fn relative_child_from_context() {
        let html = r#"<a href="/ch"><li>Chapter 1</li></a>"#;
        let q = TxQuery::parse(html);
        let nodes = q.xpath_nodes("//a");
        let name = q.xpath_string_ctx("li/text()", &nodes[0]);
        assert_eq!(name, "Chapter 1");
    }

    #[test]
    fn string_join_html_union() {
        let html = r#"
        <div class="summary__content"><p>One</p></div>
        <div class="manga-excerpt">Two</div>
        "#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(
            r#"string-join((//div[contains(@class, "summary__content")])[1]|//div[@class="manga-excerpt"], " | ")"#,
        );
        assert!(s.contains("One"), "got {s:?}");
        assert!(s.contains("Two"), "got {s:?}");
    }

    #[test]
    fn replace_and_ends_with() {
        let html = r#"<a href="/file.zip">archive.zip</a><a href="/x">ok</a>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(r#"//a[ends-with(., ".zip")]/replace(., ".zip", ".cbz")"#);
        assert_eq!(s, "archive.cbz");
    }

    #[test]
    fn resolve_uri_with_base() {
        let html = r#"<base href="https://ex.com/manga/"/><img src="cover.jpg"/>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(r#"//img/resolve-uri(@src)"#);
        assert_eq!(s, "https://ex.com/manga/cover.jpg");
    }

    #[test]
    fn following_sibling_element() {
        let html = r#"
        <div class="summary-heading">Author</div>
        <div class="summary-content">Alice</div>
        "#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(
            r#"//div[@class="summary-heading" and contains(., "Author")]/following-sibling::div"#,
        );
        assert_eq!(s, "Alice");
    }

    #[test]
    fn preceding_sibling_li() {
        let html = r#"
        <ul class="pagination">
          <li><a>1</a></li>
          <li><a>2</a></li>
          <li><a rel="next">next</a></li>
        </ul>
        "#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(
            r#"//a[@rel="next"]/parent::li/preceding-sibling::li[1]/a"#,
        );
        assert_eq!(s, "2");
    }

    #[test]
    fn position_eq_predicate() {
        let html = r#"<ul><li>a</li><li>b</li><li>c</li></ul>"#;
        let q = TxQuery::parse(html);
        assert_eq!(q.xpath_string("//ul/li[position()=2]"), "b");
    }

    #[test]
    fn bang_map_operator() {
        let html = r#"<div class="item"><span class="t">Title</span></div>"#;
        let q = TxQuery::parse(html);
        let s = q.xpath_string(r#"//div[@class="item"]!span[@class="t"]"#);
        assert_eq!(s, "Title");
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
        let after = &expr[idx + 2..];
        if !after.is_empty()
            && after
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == ':')
        {
            return (
                expr[..idx].to_string(),
                Terminal::Attr(after.to_string()),
            );
        }
    }
    (expr.to_string(), Terminal::None)
}

#[derive(Clone, Debug)]
enum Pred {
    AttrEq(String, String),
    AttrContains(String, String),
    TextContains(String),
    TextStartsWith(String),
    TextEndsWith(String),
    /// `text()="Exact"` — string-value of element (collapsed).
    TextEq(String),
    SelfName(String),
    And(Vec<Pred>),
    Or(Vec<Pred>),
}

#[derive(Clone, Debug)]
enum PositionPred {
    Index(usize),
    Last,
    LastMinus(usize),
}

#[derive(Clone, Debug)]
enum Axis {
    Child,
    Descendant,
    FollowingSibling,
    PrecedingSibling,
    Parent,
    Ancestor,
}

#[derive(Clone)]
struct Step {
    axis: Axis,
    name: String,
    preds: Vec<Pred>,
    position: Option<PositionPred>,
}

fn parse_steps(expr: &str) -> Vec<Step> {
    let mut steps = Vec::new();
    let mut rest = expr.trim();
    while !rest.is_empty() {
        let axis;
        if rest.starts_with(".//") {
            axis = Axis::Descendant;
            rest = &rest[3..];
        } else if rest.starts_with("./") {
            axis = Axis::Child;
            rest = &rest[2..];
        } else if rest.starts_with("//") {
            axis = Axis::Descendant;
            rest = &rest[2..];
        } else if let Some(r) = rest.strip_prefix("/following-sibling::") {
            axis = Axis::FollowingSibling;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("following-sibling::") {
            axis = Axis::FollowingSibling;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("/preceding-sibling::") {
            axis = Axis::PrecedingSibling;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("preceding-sibling::") {
            axis = Axis::PrecedingSibling;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("/parent::") {
            axis = Axis::Parent;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("parent::") {
            axis = Axis::Parent;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("/ancestor::") {
            axis = Axis::Ancestor;
            rest = r;
        } else if let Some(r) = rest.strip_prefix("ancestor::") {
            axis = Axis::Ancestor;
            rest = r;
        } else if rest.starts_with('/') {
            axis = Axis::Child;
            rest = &rest[1..];
        } else if steps.is_empty() {
            axis = Axis::Child;
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
        let mut position = None;
        while rest.starts_with('[') {
            let Some(end) = find_closing_bracket(rest) else {
                break;
            };
            let inner = &rest[1..end];
            if let Some(pos) = parse_position(inner) {
                position = Some(pos);
            } else if let Some(p) = parse_pred(inner) {
                preds.push(p);
            }
            rest = &rest[end + 1..];
        }

        steps.push(Step {
            axis,
            name,
            preds,
            position,
        });
    }
    steps
}

fn parse_position(inner: &str) -> Option<PositionPred> {
    let inner = inner.trim();
    if inner == "last()" {
        return Some(PositionPred::Last);
    }
    if let Some(rest) = inner.strip_prefix("last()-") {
        let n: usize = rest.trim().parse().ok()?;
        return Some(PositionPred::LastMinus(n));
    }
    // position()=N
    static POS: OnceLock<Regex> = OnceLock::new();
    let pos = POS.get_or_init(|| Regex::new(r#"^position\(\)\s*=\s*(\d+)$"#).unwrap());
    if let Some(c) = pos.captures(inner) {
        let n: usize = c[1].parse().ok()?;
        if n >= 1 {
            return Some(PositionPred::Index(n));
        }
        return None;
    }
    let n: usize = inner.parse().ok()?;
    if n >= 1 {
        Some(PositionPred::Index(n))
    } else {
        None
    }
}

fn apply_position(nodes: Vec<DomNode>, pos: Option<&PositionPred>) -> Vec<DomNode> {
    match pos {
        None => nodes,
        Some(PositionPred::Index(n)) => nodes.into_iter().nth(n - 1).into_iter().collect(),
        Some(PositionPred::Last) => nodes.into_iter().last().into_iter().collect(),
        Some(PositionPred::LastMinus(k)) => {
            if nodes.len() > *k {
                let idx = nodes.len() - 1 - k;
                nodes.into_iter().nth(idx).into_iter().collect()
            } else {
                Vec::new()
            }
        }
    }
}

fn find_closing_bracket(s: &str) -> Option<usize> {
    let mut depth = 0usize;
    let mut in_quote: Option<u8> = None;
    for (i, b) in s.bytes().enumerate() {
        if let Some(q) = in_quote {
            if b == q {
                in_quote = None;
            }
            continue;
        }
        match b {
            b'\'' | b'"' => in_quote = Some(b),
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

fn split_top_level<'a>(s: &'a str, sep: char) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth_br = 0i32;
    let mut depth_par = 0i32;
    let mut in_quote: Option<char> = None;
    for (i, c) in s.char_indices() {
        if let Some(q) = in_quote {
            if c == q {
                in_quote = None;
            }
            continue;
        }
        match c {
            '\'' | '"' => in_quote = Some(c),
            '[' => depth_br += 1,
            ']' => depth_br -= 1,
            '(' => depth_par += 1,
            ')' => depth_par -= 1,
            ch if ch == sep && depth_br == 0 && depth_par == 0 => {
                out.push(&s[start..i]);
                start = i + c.len_utf8();
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

fn parse_pred(inner: &str) -> Option<Pred> {
    let inner = inner.trim();
    if let Some(parts) = split_bool_op(inner, " or ") {
        let preds: Vec<Pred> = parts.into_iter().filter_map(parse_pred).collect();
        return match preds.len() {
            0 => None,
            1 => preds.into_iter().next(),
            _ => Some(Pred::Or(preds)),
        };
    }
    if let Some(parts) = split_bool_op(inner, " and ") {
        let preds: Vec<Pred> = parts.into_iter().filter_map(parse_pred).collect();
        return match preds.len() {
            0 => None,
            1 => preds.into_iter().next(),
            _ => Some(Pred::And(preds)),
        };
    }
    parse_pred_atom(inner)
}

fn split_bool_op<'a>(inner: &'a str, op: &str) -> Option<Vec<&'a str>> {
    if !inner.contains(op.trim()) {
        return None;
    }
    let parts = split_top_level_str(inner, op);
    if parts.len() > 1 {
        Some(parts)
    } else {
        None
    }
}

fn split_top_level_str<'a>(s: &'a str, sep: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth_br = 0i32;
    let mut depth_par = 0i32;
    let mut in_quote: Option<char> = None;
    let bytes = s.as_bytes();
    let sep_bytes = sep.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let c = s[i..].chars().next().unwrap();
        let clen = c.len_utf8();
        if let Some(q) = in_quote {
            if c == q {
                in_quote = None;
            }
            i += clen;
            continue;
        }
        match c {
            '\'' | '"' => {
                in_quote = Some(c);
                i += clen;
            }
            '[' => {
                depth_br += 1;
                i += clen;
            }
            ']' => {
                depth_br -= 1;
                i += clen;
            }
            '(' => {
                depth_par += 1;
                i += clen;
            }
            ')' => {
                depth_par -= 1;
                i += clen;
            }
            _ if depth_br == 0
                && depth_par == 0
                && i + sep_bytes.len() <= bytes.len()
                && &bytes[i..i + sep_bytes.len()] == sep_bytes =>
            {
                out.push(&s[start..i]);
                i += sep_bytes.len();
                start = i;
            }
            _ => i += clen,
        }
    }
    out.push(&s[start..]);
    out
}

fn parse_pred_atom(inner: &str) -> Option<Pred> {
    let inner = inner.trim();
    static EQ: OnceLock<Regex> = OnceLock::new();
    static AC: OnceLock<Regex> = OnceLock::new();
    static TC: OnceLock<Regex> = OnceLock::new();
    static TE: OnceLock<Regex> = OnceLock::new();
    static SW: OnceLock<Regex> = OnceLock::new();
    static SF: OnceLock<Regex> = OnceLock::new();

    let eq = EQ.get_or_init(|| {
        Regex::new(r#"^@([a-zA-Z0-9_\-:]+)\s*=\s*['"]([^'"]*)['"]$"#).unwrap()
    });
    if let Some(c) = eq.captures(inner) {
        return Some(Pred::AttrEq(c[1].to_string(), c[2].to_string()));
    }
    let ac = AC.get_or_init(|| {
        Regex::new(r#"^contains\(@([a-zA-Z0-9_\-:]+)\s*,\s*['"]([^'"]*)['"]\)$"#).unwrap()
    });
    if let Some(c) = ac.captures(inner) {
        return Some(Pred::AttrContains(c[1].to_string(), c[2].to_string()));
    }
    let te = TE.get_or_init(|| Regex::new(r#"^text\(\)\s*=\s*['"]([^'"]*)['"]$"#).unwrap());
    if let Some(c) = te.captures(inner) {
        return Some(Pred::TextEq(c[1].to_string()));
    }
    let sw = SW.get_or_init(|| {
        Regex::new(r#"^starts-with\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*\)$"#).unwrap()
    });
    if let Some(c) = sw.captures(inner) {
        return Some(Pred::TextStartsWith(c[1].to_string()));
    }
    static EW: OnceLock<Regex> = OnceLock::new();
    let ew = EW.get_or_init(|| {
        Regex::new(r#"^ends-with\(\s*\.\s*,\s*['"]([^'"]*)['"]\s*\)$"#).unwrap()
    });
    if let Some(c) = ew.captures(inner) {
        return Some(Pred::TextEndsWith(c[1].to_string()));
    }
    let tc = TC.get_or_init(|| {
        Regex::new(r#"^contains\(\.\s*,\s*['"]([^'"]*)['"]\)$"#).unwrap()
    });
    if let Some(c) = tc.captures(inner) {
        return Some(Pred::TextContains(c[1].to_string()));
    }
    let sf = SF.get_or_init(|| Regex::new(r#"^self::([a-zA-Z0-9_-]+)$"#).unwrap());
    if let Some(c) = sf.captures(inner) {
        return Some(Pred::SelfName(c[1].to_string()));
    }
    None
}

fn match_pred(node: &DomNode, pred: &Pred) -> bool {
    match pred {
        Pred::AttrEq(k, v) => node.attr(k) == Some(v.as_str()),
        Pred::AttrContains(k, v) => node.attr(k).is_some_and(|a| a.contains(v)),
        Pred::TextContains(v) => node.all_text().contains(v.as_str()),
        Pred::TextStartsWith(v) => node.all_text().starts_with(v.as_str()),
        Pred::TextEndsWith(v) => node.all_text().ends_with(v.as_str()),
        Pred::TextEq(v) => node.all_text() == v.as_str(),
        Pred::SelfName(name) => match node {
            DomNode::Elem { tag, .. } => tag.eq_ignore_ascii_case(name),
            _ => false,
        },
        Pred::And(parts) => parts.iter().all(|p| match_pred(node, p)),
        Pred::Or(parts) => parts.iter().any(|p| match_pred(node, p)),
    }
}

fn match_name(node: &DomNode, name: &str) -> bool {
    match node {
        DomNode::Elem { tag, .. } => name == "*" || tag.eq_ignore_ascii_case(name),
        DomNode::Text(_) => false,
    }
}

fn eval_path(roots: &[DomNode], expr: &str) -> Vec<DomNode> {
    let steps = parse_steps(expr);
    let mut current: Vec<DomNode> = roots.to_vec();
    for step in &steps {
        let mut next = Vec::new();
        match step.axis {
            Axis::Descendant => {
                if step.position.is_some() {
                    for n in &current {
                        collect_desc_child_pos(n, step, &mut next);
                    }
                } else {
                    for n in &current {
                        collect_desc(n, step, &mut next);
                    }
                }
            }
            Axis::Child => {
                for n in &current {
                    if let DomNode::Elem { children, .. } = n {
                        let mut batch = Vec::new();
                        for c in children {
                            if match_name(c, &step.name)
                                && step.preds.iter().all(|p| match_pred(c, p))
                            {
                                batch.push(c.clone());
                            }
                        }
                        next.extend(apply_position(batch, step.position.as_ref()));
                    }
                }
            }
            Axis::FollowingSibling | Axis::PrecedingSibling => {
                for n in &current {
                    let sibs = sibling_elements(roots, n, matches!(step.axis, Axis::FollowingSibling));
                    let mut batch = Vec::new();
                    for c in sibs {
                        if match_name(&c, &step.name)
                            && step.preds.iter().all(|p| match_pred(&c, p))
                        {
                            batch.push(c);
                        }
                    }
                    next.extend(apply_position(batch, step.position.as_ref()));
                }
            }
            Axis::Parent => {
                for n in &current {
                    if let Some(p) = find_parent(roots, n) {
                        if match_name(&p, &step.name)
                            && step.preds.iter().all(|pred| match_pred(&p, pred))
                        {
                            next.push(p);
                        }
                    }
                }
                next = apply_position(next, step.position.as_ref());
            }
            Axis::Ancestor => {
                for n in &current {
                    let mut ancestors = Vec::new();
                    collect_ancestors(roots, n, step, &mut ancestors);
                    next.extend(apply_position(ancestors, step.position.as_ref()));
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

fn collect_desc_child_pos(node: &DomNode, step: &Step, out: &mut Vec<DomNode>) {
    if let DomNode::Elem { children, .. } = node {
        let mut batch = Vec::new();
        for c in children {
            if match_name(c, &step.name) && step.preds.iter().all(|p| match_pred(c, p)) {
                batch.push(c.clone());
            }
        }
        out.extend(apply_position(batch, step.position.as_ref()));
        for c in children {
            collect_desc_child_pos(c, step, out);
        }
    }
}

fn same_elem(a: &DomNode, b: &DomNode) -> bool {
    // Structural compare (nodes are cloned frequently).
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
        ) => {
            t1.eq_ignore_ascii_case(t2)
                && a1 == a2
                && c1.len() == c2.len()
                && a.all_text() == b.all_text()
        }
        (DomNode::Text(t1), DomNode::Text(t2)) => t1 == t2,
        _ => false,
    }
}

fn find_parent_in(nodes: &[DomNode], target: &DomNode) -> Option<DomNode> {
    for n in nodes {
        if let DomNode::Elem { children, .. } = n {
            for c in children {
                if same_elem(c, target) {
                    return Some(n.clone());
                }
            }
            if let Some(p) = find_parent_in(children, target) {
                return Some(p);
            }
        }
    }
    None
}

fn find_parent(roots: &[DomNode], target: &DomNode) -> Option<DomNode> {
    find_parent_in(roots, target)
}

fn sibling_elements(roots: &[DomNode], target: &DomNode, following: bool) -> Vec<DomNode> {
    let parent = match find_parent(roots, target) {
        Some(p) => p,
        None => return Vec::new(),
    };
    let DomNode::Elem { children, .. } = parent else {
        return Vec::new();
    };
    let idx = children.iter().position(|c| same_elem(c, target));
    let Some(idx) = idx else {
        return Vec::new();
    };
    let slice: Vec<DomNode> = if following {
        children[idx + 1..]
            .iter()
            .filter(|c| matches!(c, DomNode::Elem { .. }))
            .cloned()
            .collect()
    } else {
        children[..idx]
            .iter()
            .rev()
            .filter(|c| matches!(c, DomNode::Elem { .. }))
            .cloned()
            .collect()
    };
    slice
}

fn collect_ancestors(roots: &[DomNode], node: &DomNode, step: &Step, out: &mut Vec<DomNode>) {
    let mut cur = find_parent(roots, node);
    while let Some(p) = cur {
        if match_name(&p, &step.name) && step.preds.iter().all(|pred| match_pred(&p, pred)) {
            out.push(p.clone());
        }
        cur = find_parent(roots, &p);
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
    let targets = eval_expr(roots, path);
    let target = targets.first()?;
    find_following_text(roots, target, index)
}

fn elem_match_key(node: &DomNode) -> Option<(String, String)> {
    match node {
        DomNode::Elem { tag, .. } => Some((tag.to_ascii_lowercase(), node.all_text())),
        _ => None,
    }
}

fn find_following_text(nodes: &[DomNode], target: &DomNode, index: usize) -> Option<String> {
    let key = elem_match_key(target)?;

    for (i, child) in nodes.iter().enumerate() {
        if elem_match_key(child).as_ref() == Some(&key) {
            let mut count = 0usize;
            for sib in nodes.iter().skip(i + 1) {
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
    }

    for node in nodes {
        if let DomNode::Elem { children, .. } = node {
            if let Some(r) = find_following_text(children, target, index) {
                return Some(r);
            }
        }
    }
    None
}
