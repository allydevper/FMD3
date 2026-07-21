//! Minimal FMD2-style `json(...)` XPath helpers for modules like ComicK.

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
    // Start after "json("
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
    let rest = e[end + 1..].trim_start_matches('.').trim().to_string();
    Some((inner, rest))
}

pub fn parse_json_text(text: &str) -> Option<Json> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    serde_json::from_str(t).ok()
}

/// Evaluate a relative JSON path used as XPathString context (ComicK subset).
pub fn json_string_at(root: &Json, expr: &str) -> String {
    let expr = expr.trim();
    if expr.is_empty() {
        return String::new();
    }
    if let Some(inner) = expr.strip_prefix("string-join(") {
        if let Some(end) = inner.rfind(')') {
            let inside = &inner[..end];
            let (path, sep) = split_string_join_args(inside);
            let vals = json_collect_strings(root, path.trim());
            return vals.join(sep);
        }
    }
    // Single value path: title, status, default_thumbnail, …
    json_collect_strings(root, expr)
        .into_iter()
        .next()
        .unwrap_or_default()
}

fn split_string_join_args(inside: &str) -> (&str, &'static str) {
    // string-join(path, ", ") — take the first `, "` as separator start (path has no quotes).
    if let Some(idx) = inside.find(", \"") {
        return (inside[..idx].trim(), ", ");
    }
    if let Some(idx) = inside.find(", '") {
        return (inside[..idx].trim(), ", ");
    }
    if let Some((path, _)) = inside.split_once(',') {
        return (path.trim(), ", ");
    }
    (inside.trim(), ", ")
}

/// Collect strings along a path like `title`, `authors?*/name`, `chapter.images().url`.
pub fn json_collect_strings(root: &Json, path: &str) -> Vec<String> {
    let path = path.trim().trim_start_matches('.');
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

#[derive(Debug)]
enum Seg {
    Key(String),
    /// `key?*` or `key()` — iterate array under key
    ArrayKey(String),
}

fn split_json_segments(path: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let mut rest = path;
    while !rest.is_empty() {
        rest = rest.trim_start_matches('.').trim_start_matches('/');
        if rest.is_empty() {
            break;
        }
        // images() or key?*
        if let Some(pos) = rest.find("()*") {
            // unlikely
            let _ = pos;
        }
        if let Some(name) = rest.strip_suffix("()*") {
            // shouldn't happen
            let _ = name;
        }
        // Take until . or /
        let (piece, after) = if let Some(i) = rest.find(['.', '/']) {
            (&rest[..i], &rest[i + 1..])
        } else {
            (rest, "")
        };
        rest = after;
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        if let Some(name) = piece.strip_suffix("?*") {
            out.push(Seg::ArrayKey(name.to_string()));
        } else if let Some(name) = piece.strip_suffix("()") {
            out.push(Seg::ArrayKey(name.to_string()));
        } else {
            out.push(Seg::Key(piece.to_string()));
        }
    }
    out
}

fn step_json(cur: &Json, seg: &Seg) -> Vec<Json> {
    match seg {
        Seg::Key(k) => match cur {
            Json::Object(map) => map.get(k).cloned().into_iter().collect(),
            Json::Array(arr) => {
                // Index numeric key
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
            let node = match cur {
                Json::Object(map) => map.get(k),
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
    fn split_json_with_path() {
        let (inner, rest) =
            split_json_expr("json(//script[@id=\"sv-data\"]).chapter.images().url").unwrap();
        assert_eq!(inner, "//script[@id=\"sv-data\"]");
        assert_eq!(rest, "chapter.images().url");
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
}
