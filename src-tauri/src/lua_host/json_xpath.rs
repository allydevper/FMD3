//! FMD2-style `json(...)` / `parse-json(.)` XPath helpers for API modules.

use serde_json::Value as Json;

/// Extract `inner` from `json(inner)` or `json(inner).rest` → (inner_xpath, rest_json_path).
pub fn split_json_expr(expr: &str) -> Option<(String, String)> {
    let e = expr.trim();
    if !e.starts_with("json(") {
        return None;
    }
    let bytes = e.as_bytes();
    let mut depth = 0i32;
    let mut end = None;
    for (i, &b) in bytes.iter().enumerate().skip(5) {
        match b {
            b'(' => depth += 1,
            b')' => {
                if depth == 0 {
                    end = Some(i);
                    break;
                }
                depth -= 1;
            }
            _ => {}
        }
    }
    let end = end?;
    let inner = e[5..end].trim().to_string();
    let mut rest = e[end + 1..].trim().to_string();
    if rest.starts_with('.') {
        rest = rest[1..].to_string();
    }
    Some((inner, rest))
}

/// `parse-json(.)` or `parse-json(.)?path` / `parse-json(.).path` → remaining JSON path.
pub fn split_parse_json_expr(expr: &str) -> Option<String> {
    let e = expr.trim();
    let rest = e.strip_prefix("parse-json(.)")?;
    let rest = rest.trim();
    if rest.is_empty() {
        return Some(String::new());
    }
    let rest = rest
        .trim_start_matches('?')
        .trim_start_matches('.')
        .to_string();
    Some(rest)
}

pub fn parse_json_text(text: &str) -> Option<Json> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    // Strip HTML/script wrappers sometimes present around JSON blobs.
    if let Ok(v) = serde_json::from_str::<Json>(t) {
        return Some(v);
    }
    // Try first `{…}` or `[…]` substring.
    if let Some(start) = t.find(['{', '[']) {
        let open = t.as_bytes()[start];
        let close = if open == b'{' { b'}' } else { b']' };
        if let Some(end) = find_matching(t.as_bytes(), start, open, close) {
            return serde_json::from_str(&t[start..=end]).ok();
        }
    }
    None
}

fn find_matching(bytes: &[u8], start: usize, open: u8, close: u8) -> Option<usize> {
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escape = false;
    for i in start..bytes.len() {
        let b = bytes[i];
        if in_str {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b if b == open => depth += 1,
            b if b == close => {
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

/// Evaluate a relative JSON path / string expr (ComicK, Iken, Olympus, …).
pub fn json_string_at(root: &Json, expr: &str) -> String {
    eval_string_expr(root, expr)
        .into_iter()
        .next()
        .unwrap_or_default()
}

/// Collect all string values for a path or string-join expression.
pub fn json_collect_strings(root: &Json, path: &str) -> Vec<String> {
    eval_string_expr(root, path)
}

fn eval_string_expr(root: &Json, expr: &str) -> Vec<String> {
    let expr = expr.trim();
    if expr.is_empty() {
        return json_to_strings(root);
    }
    if let Some(inner) = expr.strip_prefix("string-join(") {
        if let Some(end) = find_closing_paren(inner) {
            let inside = &inner[..end];
            let (seq_expr, sep) = split_string_join_args(inside);
            let vals = eval_sequence_expr(root, seq_expr.trim());
            return vec![vals.join(&sep)];
        }
    }
    if expr.contains("||") {
        let parts: Vec<String> = split_top_level(expr, "||")
            .into_iter()
            .flat_map(|p| eval_string_expr(root, p.trim()))
            .collect();
        return vec![parts.concat()];
    }
    if let Some(args) = strip_fn(expr, "concat") {
        let mut out = String::new();
        for a in split_top_level(args, ",") {
            out.push_str(&eval_string_expr(root, a.trim()).join(""));
        }
        return vec![out];
    }
    if let Some(arg) = strip_fn(expr, "upper-case") {
        return eval_string_expr(root, arg)
            .into_iter()
            .map(|s| s.to_uppercase())
            .collect();
    }
    if let Some(arg) = strip_fn(expr, "lower-case") {
        return eval_string_expr(root, arg)
            .into_iter()
            .map(|s| s.to_lowercase())
            .collect();
    }
    if let Some(args) = strip_fn(expr, "substring") {
        return eval_substring(root, args);
    }
    // Plain JSON path
    walk_json_path(root, expr)
}

fn eval_sequence_expr(root: &Json, expr: &str) -> Vec<String> {
    let expr = expr.trim();
    // (a, b, c) sequence
    if let Some(inner) = expr.strip_prefix('(') {
        if let Some(end) = find_closing_paren(inner) {
            let inside = &inner[..end];
            let mut out = Vec::new();
            for part in split_top_level(inside, ",") {
                out.extend(eval_string_expr(root, part.trim()));
            }
            return out;
        }
    }
    eval_string_expr(root, expr)
}

fn eval_substring(root: &Json, args: &str) -> Vec<String> {
    let parts = split_top_level(args, ",");
    if parts.is_empty() {
        return Vec::new();
    }
    let base = eval_string_expr(root, parts[0].trim())
        .into_iter()
        .next()
        .unwrap_or_default();
    let start: usize = parts
        .get(1)
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(1);
    let len: Option<usize> = parts.get(2).and_then(|s| s.trim().parse().ok());
    // XPath substring is 1-based
    let start_idx = start.saturating_sub(1);
    let chars: Vec<char> = base.chars().collect();
    if start_idx >= chars.len() {
        return vec![String::new()];
    }
    let slice = match len {
        Some(n) => chars[start_idx..].iter().take(n).collect::<String>(),
        None => chars[start_idx..].iter().collect::<String>(),
    };
    vec![slice]
}

fn strip_fn<'a>(expr: &'a str, name: &str) -> Option<&'a str> {
    let expr = expr.trim();
    let prefix = format!("{name}(");
    let rest = expr.strip_prefix(&prefix)?;
    let end = find_closing_paren(rest)?;
    // Require nothing after closing paren (or only whitespace)
    if !rest[end + 1..].trim().is_empty() {
        return None;
    }
    Some(rest[..end].trim())
}

fn find_closing_paren(s: &str) -> Option<usize> {
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

fn split_string_join_args(inside: &str) -> (String, String) {
    // Last top-level comma separates sequence from separator string.
    let parts = split_top_level(inside, ",");
    if parts.len() < 2 {
        return (inside.trim().to_string(), ", ".to_string());
    }
    let sep_raw = parts.last().unwrap().trim();
    let sep = unquote(sep_raw).unwrap_or_else(|| sep_raw.to_string());
    let seq = parts[..parts.len() - 1].join(",");
    (seq.trim().to_string(), sep)
}

fn unquote(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"') || (b[0] == b'\'' && b[s.len() - 1] == b'\'') {
            return Some(s[1..s.len() - 1].to_string());
        }
    }
    None
}

fn split_top_level<'a>(s: &'a str, sep: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth_par = 0i32;
    let mut in_quote: Option<char> = None;
    let bytes = s.as_bytes();
    let sep_b = sep.as_bytes();
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
            '(' => {
                depth_par += 1;
                i += clen;
            }
            ')' => {
                depth_par -= 1;
                i += clen;
            }
            _ if depth_par == 0
                && i + sep_b.len() <= bytes.len()
                && &bytes[i..i + sep_b.len()] == sep_b =>
            {
                out.push(&s[start..i]);
                i += sep_b.len();
                start = i;
            }
            _ => i += clen,
        }
    }
    out.push(&s[start..]);
    out
}

fn walk_json_path(root: &Json, path: &str) -> Vec<String> {
    let path = path.trim().trim_start_matches('.').trim_start_matches('?');
    if path.is_empty() {
        return json_to_strings(root);
    }
    let mut currents = vec![root.clone()];
    for seg in split_json_segments(path) {
        let mut next = Vec::new();
        for cur in &currents {
            next.extend(step_json(cur, &seg));
        }
        currents = next;
        if currents.is_empty() {
            break;
        }
    }
    currents.into_iter().flat_map(|v| json_to_strings(&v)).collect()
}

/// Navigate to a JSON sub-value (for XPath → JsonNode).
pub fn json_navigate(root: &Json, path: &str) -> Json {
    let path = path.trim().trim_start_matches('.').trim_start_matches('?');
    if path.is_empty() {
        return root.clone();
    }
    let mut currents = vec![root.clone()];
    for seg in split_json_segments(path) {
        let mut next = Vec::new();
        for cur in &currents {
            next.extend(step_json(cur, &seg));
        }
        currents = next;
        if currents.is_empty() {
            return Json::Null;
        }
    }
    if currents.len() == 1 {
        currents.pop().unwrap()
    } else {
        Json::Array(currents)
    }
}

#[derive(Debug, Clone)]
enum JsonPred {
    /// `namespace="1"` / `name="translated"`
    FieldEq(String, String),
    Not(Box<JsonPred>),
    And(Vec<JsonPred>),
}

#[derive(Debug)]
enum Seg {
    Key(String),
    /// `key?*` or `key()` — iterate array under key
    ArrayKey(String),
    /// Leading `()` / `?*` — iterate current value if array
    IterateSelf,
    /// `[namespace="1"]` — filter current sequence (usually after `tags()`)
    Filter(JsonPred),
}

fn split_json_segments(path: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut rest = path.trim();
    while !rest.is_empty() {
        rest = rest
            .trim_start_matches('.')
            .trim_start_matches('/')
            .trim_start_matches('?');
        if rest.is_empty() {
            break;
        }
        // Leading iterate-self, optional filter
        if rest.starts_with("()") {
            out.push(Seg::IterateSelf);
            rest = &rest[2..];
            rest = push_filters(&mut out, rest);
            continue;
        }
        if rest.starts_with("*") && (rest.len() == 1 || rest.as_bytes()[1] != b'*') {
            out.push(Seg::IterateSelf);
            rest = &rest[1..];
            rest = push_filters(&mut out, rest);
            continue;
        }

        // Standalone `[pred]` (if somehow left after a key)
        if rest.starts_with('[') {
            rest = push_filters(&mut out, rest);
            if rest.starts_with('[') {
                // unparsed bracket — skip one char to avoid infinite loop
                rest = &rest[1..];
            }
            continue;
        }

        // name()* or name?* or name()[pred]
        if let Some((name, after)) = take_ident(rest) {
            let after = after.trim_start();
            if after.starts_with("()*") {
                out.push(Seg::ArrayKey(name.to_string()));
                rest = push_filters(&mut out, &after[3..]);
                continue;
            }
            if after.starts_with("()") {
                out.push(Seg::ArrayKey(name.to_string()));
                rest = push_filters(&mut out, &after[2..]);
                continue;
            }
            if after.starts_with("?*") {
                out.push(Seg::ArrayKey(name.to_string()));
                rest = push_filters(&mut out, &after[2..]);
                continue;
            }
            out.push(Seg::Key(name.to_string()));
            rest = after;
            continue;
        }

        // Fallback: take until . or ? or [
        let end = rest
            .find(['.', '?', '['])
            .unwrap_or(rest.len());
        let piece = &rest[..end];
        rest = &rest[end..];
        if piece.is_empty() {
            continue;
        }
        if let Some(n) = piece.strip_suffix("()*") {
            out.push(Seg::ArrayKey(n.to_string()));
            rest = push_filters(&mut out, rest);
        } else if let Some(n) = piece.strip_suffix("()") {
            out.push(Seg::ArrayKey(n.to_string()));
            rest = push_filters(&mut out, rest);
        } else if let Some(n) = piece.strip_suffix("?*") {
            out.push(Seg::ArrayKey(n.to_string()));
            rest = push_filters(&mut out, rest);
        } else {
            out.push(Seg::Key(piece.to_string()));
        }
    }
    out
}

/// Consume zero or more `[pred]` suffixes; push Filter segs; return remaining.
fn push_filters<'a>(out: &mut Vec<Seg>, rest: &'a str) -> &'a str {
    let mut rest = rest;
    while let Some((pred, after)) = take_bracket_pred(rest) {
        out.push(Seg::Filter(pred));
        rest = after;
    }
    rest
}

fn take_bracket_pred(s: &str) -> Option<(JsonPred, &str)> {
    let s = s.trim_start();
    if !s.starts_with('[') {
        return None;
    }
    let end = find_closing_bracket_json(s)?;
    let inner = &s[1..end];
    let pred = parse_json_pred(inner)?;
    Some((pred, s[end + 1..].trim_start()))
}

fn find_closing_bracket_json(s: &str) -> Option<usize> {
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

fn parse_json_pred(inner: &str) -> Option<JsonPred> {
    let inner = inner.trim();
    if inner.is_empty() {
        return None;
    }
    // Split top-level ` and `
    let and_parts = split_json_bool(inner, " and ");
    if and_parts.len() > 1 {
        let preds: Vec<JsonPred> = and_parts.into_iter().filter_map(parse_json_pred).collect();
        return match preds.len() {
            0 => None,
            1 => preds.into_iter().next(),
            _ => Some(JsonPred::And(preds)),
        };
    }
    if let Some(rest) = inner.strip_prefix("not(") {
        if rest.ends_with(')') {
            let nested = &rest[..rest.len() - 1];
            let p = parse_json_pred(nested)?;
            return Some(JsonPred::Not(Box::new(p)));
        }
    }
    // field="value" / field='value'
    let eq = inner.find('=')?;
    let key = inner[..eq].trim();
    let val_raw = inner[eq + 1..].trim();
    if key.is_empty() {
        return None;
    }
    let val = unquote_json_lit(val_raw).unwrap_or_else(|| val_raw.to_string());
    Some(JsonPred::FieldEq(key.to_string(), val))
}

fn split_json_bool<'a>(s: &'a str, op: &str) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut depth_par = 0i32;
    let mut in_quote: Option<char> = None;
    let bytes = s.as_bytes();
    let op_b = op.as_bytes();
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
            '(' => {
                depth_par += 1;
                i += clen;
            }
            ')' => {
                depth_par -= 1;
                i += clen;
            }
            _ if depth_par == 0
                && i + op_b.len() <= bytes.len()
                && &bytes[i..i + op_b.len()] == op_b =>
            {
                out.push(&s[start..i]);
                i += op_b.len();
                start = i;
            }
            _ => i += clen,
        }
    }
    out.push(&s[start..]);
    out
}

fn unquote_json_lit(s: &str) -> Option<String> {
    let s = s.trim();
    if s.len() >= 2 {
        let b = s.as_bytes();
        if (b[0] == b'"' && b[s.len() - 1] == b'"') || (b[0] == b'\'' && b[s.len() - 1] == b'\'')
        {
            return Some(s[1..s.len() - 1].to_string());
        }
    }
    None
}

fn match_json_pred(v: &Json, pred: &JsonPred) -> bool {
    match pred {
        JsonPred::FieldEq(k, expect) => field_eq_str(v, k, expect),
        JsonPred::Not(inner) => !match_json_pred(v, inner),
        JsonPred::And(parts) => parts.iter().all(|p| match_json_pred(v, p)),
    }
}

fn field_eq_str(v: &Json, key: &str, expect: &str) -> bool {
    let Some(val) = v.get(key) else {
        return false;
    };
    match val {
        Json::String(s) => s == expect,
        Json::Number(n) => n.to_string() == expect,
        Json::Bool(b) => b.to_string() == expect,
        Json::Null => expect.is_empty() || expect == "null",
        _ => false,
    }
}

fn take_ident(s: &str) -> Option<(&str, &str)> {
    let end = s
        .char_indices()
        .find(|(_, c)| !c.is_ascii_alphanumeric() && *c != '_' && *c != '-')
        .map(|(i, _)| i)
        .unwrap_or(s.len());
    if end == 0 {
        return None;
    }
    Some((&s[..end], &s[end..]))
}

fn step_json(cur: &Json, seg: &Seg) -> Vec<Json> {
    match seg {
        Seg::IterateSelf => match cur {
            Json::Array(arr) => arr.clone(),
            other => vec![other.clone()],
        },
        Seg::Filter(pred) => {
            if match_json_pred(cur, pred) {
                vec![cur.clone()]
            } else {
                Vec::new()
            }
        }
        Seg::Key(k) => match cur {
            Json::Object(map) => map.get(k).cloned().into_iter().collect(),
            Json::Array(arr) => {
                if let Ok(i) = k.parse::<usize>() {
                    arr.get(i).cloned().into_iter().collect()
                } else {
                    arr.iter()
                        .filter_map(|v| v.get(k).cloned())
                        .collect()
                }
            }
            _ => Vec::new(),
        },
        Seg::ArrayKey(k) => {
            if k.is_empty() {
                return step_json(cur, &Seg::IterateSelf);
            }
            let node = match cur {
                Json::Object(map) => map.get(k),
                Json::Array(arr) => {
                    return arr
                        .iter()
                        .flat_map(|v| step_json(v, &Seg::ArrayKey(k.clone())))
                        .collect();
                }
                _ => None,
            };
            match node {
                Some(Json::Array(arr)) => arr.clone(),
                Some(other) => vec![other.clone()],
                None => Vec::new(),
            }
        }
    }
}

fn json_to_strings(v: &Json) -> Vec<String> {
    match v {
        Json::Null => Vec::new(),
        Json::Bool(b) => vec![b.to_string()],
        Json::Number(n) => vec![n.to_string()],
        Json::String(s) => vec![s.clone()],
        Json::Array(arr) => arr.iter().flat_map(json_to_strings).collect(),
        Json::Object(_) => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn split_json_simple() {
        let (inner, rest) = split_json_expr("json(//script[@id=\"comic-data\"])").unwrap();
        assert_eq!(inner, "//script[@id=\"comic-data\"]");
        assert!(rest.is_empty());
    }

    #[test]
    fn split_json_star() {
        let (inner, rest) = split_json_expr("json(*).data.series.last_page").unwrap();
        assert_eq!(inner, "*");
        assert_eq!(rest, "data.series.last_page");
    }

    #[test]
    fn split_json_with_path() {
        let (inner, rest) =
            split_json_expr("json(//script[@id=\"sv-data\"]).chapter.images().url").unwrap();
        assert_eq!(inner, "//script[@id=\"sv-data\"]");
        assert_eq!(rest, "chapter.images().url");
    }

    #[test]
    fn split_parse_json() {
        assert_eq!(
            split_parse_json_expr("parse-json(.)?post").as_deref(),
            Some("post")
        );
        assert_eq!(
            split_parse_json_expr("parse-json(.)?data?*?data").as_deref(),
            Some("data?*?data")
        );
    }

    #[test]
    fn string_join_authors() {
        let root = json!({
            "authors": [{"name": "A"}, {"name": "B"}],
            "title": "T"
        });
        assert_eq!(json_string_at(&root, "title"), "T");
        let collected = json_collect_strings(&root, "authors?*/name");
        assert_eq!(collected, vec!["A".to_string(), "B".to_string()], "collect path");
        assert_eq!(
            json_string_at(&root, r#"string-join(authors?*/name, ", ")"#),
            "A, B"
        );
    }

    #[test]
    fn images_url() {
        let root = json!({
            "chapter": {
                "images": [
                    {"url": "https://a/1.jpg"},
                    {"url": "https://a/2.jpg"}
                ]
            }
        });
        assert_eq!(
            json_collect_strings(&root, "chapter.images().url"),
            vec!["https://a/1.jpg", "https://a/2.jpg"]
        );
    }

    #[test]
    fn iterate_root_array() {
        let root = json!([{"src": "a"}, {"src": "b"}]);
        assert_eq!(
            json_collect_strings(&root, "().src"),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn question_path_nested() {
        let root = json!({"data": [{"data": "x"}, {"data": "y"}]});
        assert_eq!(
            json_collect_strings(&root, "data?*?data"),
            vec!["x".to_string(), "y".to_string()]
        );
    }

    #[test]
    fn title_case_concat_in_string_join() {
        let root = json!({
            "genres": [{"name": "Action"}, {"name": "Comedy"}],
            "type": "manhwa"
        });
        let s = json_string_at(
            &root,
            r#"string-join((genres?*?name, concat(upper-case(substring(type, 1, 1)), lower-case(substring(type, 2)))), ", ")"#,
        );
        assert_eq!(s, "Action, Comedy, Manhwa");
    }

    #[test]
    fn custom_separator() {
        let root = json!({"names": ["a", "b"]});
        assert_eq!(
            json_string_at(&root, r#"string-join(names?*, " | ")"#),
            "a | b"
        );
    }

    #[test]
    fn navigate_post() {
        let root = json!({"post": {"title": "Hi", "seriesType": "manga"}});
        let post = json_navigate(&root, "post");
        assert_eq!(json_string_at(&post, "title"), "Hi");
    }

    #[test]
    fn schale_tags_namespace_predicates() {
        let root = json!({
            "tags": [
                {"namespace": 1, "name": "Alice"},
                {"namespace": 2, "name": "CircleX"},
                {"namespace": 3, "name": "ParodyY"},
                {"namespace": 7, "name": "Action"},
                {"namespace": 11, "name": "translated"},
                {"namespace": 11, "name": "english"}
            ]
        });
        assert_eq!(
            json_collect_strings(&root, r#"tags()[namespace="1"].name"#),
            vec!["Alice".to_string()]
        );
        assert_eq!(
            json_collect_strings(&root, r#"tags()[namespace="2"].name"#),
            vec!["CircleX".to_string()]
        );
        let genres = json_collect_strings(
            &root,
            r#"tags()[not(namespace="1") and not(namespace="2") and not(namespace="3") and not(namespace="4") and not(namespace="5") and not(namespace="7") and not(namespace="11")].name"#,
        );
        // namespace 7 is excluded in Schale Genres filter — empty here; add a free tag:
        assert!(genres.is_empty());
        let root2 = json!({
            "tags": [
                {"namespace": 1, "name": "Alice"},
                {"namespace": 8, "name": "Fantasy"}
            ]
        });
        assert_eq!(
            json_collect_strings(
                &root2,
                r#"tags()[not(namespace="1") and not(namespace="2") and not(namespace="3") and not(namespace="4") and not(namespace="5") and not(namespace="7") and not(namespace="11")].name"#
            ),
            vec!["Fantasy".to_string()]
        );
        assert_eq!(
            json_collect_strings(
                &root,
                r#"tags()[namespace="11" and not(name="translated")].name"#
            ),
            vec!["english".to_string()]
        );
    }
}
