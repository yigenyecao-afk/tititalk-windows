//! (v0.8.3 P0-2) 客户端最后一道排版清洁。跟 Mac TextPostProcess.swift 同源。
//!
//! 当前只有一条规则：CJK ↔ Latin 边界自动加空格（typeoff v1.0.53 同款）。
//!
//! 为什么放客户端：
//!   • verbatim 模式不走 polish，后端规则不生效；客户端覆盖
//!   • polish 模式后端 LLM 偶尔忘加空格，客户端再扫一遍当 belt-and-braces
//!
//! 规则严格收紧：
//!   • CJK 范围只识别中日文常用块（U+4E00-U+9FFF + U+3040-U+30FF + U+FF00-U+FFEF）
//!   • Latin 边界只识别 [a-zA-Z0-9]，避开 Markdown / 代码符号 (`/.:-_*` 等)
//!   • 已有空白的边界不重复加
//!   • 中文标点旁边不加（标点本身已起隔断作用）

pub fn add_cjk_spaces(s: &str) -> String {
    if s.is_empty() {
        return String::new();
    }
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    for i in 0..chars.len() {
        let cur = chars[i];
        out.push(cur);
        let Some(&nxt) = chars.get(i + 1) else { continue };
        if need_space(cur, nxt) {
            out.push(' ');
        }
    }
    out
}

/// 跑全套：当前只有 CJK 空格一条规则。cjk_auto_space=false 时返回原文。
pub fn normalize(s: &str, cjk_auto_space: bool) -> String {
    if cjk_auto_space {
        add_cjk_spaces(s)
    } else {
        s.to_string()
    }
}

fn need_space(a: char, b: char) -> bool {
    if is_whitespace(a) || is_whitespace(b) {
        return false;
    }
    (is_cjk(a) && is_latin_alnum(b)) || (is_latin_alnum(a) && is_cjk(b))
}

fn is_cjk(c: char) -> bool {
    let v = c as u32;
    (0x4E00..=0x9FFF).contains(&v)
        || (0x3400..=0x4DBF).contains(&v)
        || (0x3040..=0x30FF).contains(&v)
        || (0xFF00..=0xFFEF).contains(&v)
}

fn is_latin_alnum(c: char) -> bool {
    matches!(c, '0'..='9' | 'A'..='Z' | 'a'..='z')
}

fn is_whitespace(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{00A0}' | '\u{3000}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_to_latin_adds_space() {
        assert_eq!(add_cjk_spaces("打开VSCode看代码"), "打开 VSCode 看代码");
    }

    #[test]
    fn already_spaced_is_idempotent() {
        let s = "打开 VSCode 看代码";
        assert_eq!(add_cjk_spaces(s), s);
    }

    #[test]
    fn punctuation_unchanged() {
        assert_eq!(add_cjk_spaces("你好，VSCode！"), "你好，VSCode！");
    }

    #[test]
    fn pure_chinese_unchanged() {
        assert_eq!(add_cjk_spaces("你好世界"), "你好世界");
    }

    #[test]
    fn pure_latin_unchanged() {
        assert_eq!(add_cjk_spaces("hello world"), "hello world");
    }

    #[test]
    fn numbers_too() {
        assert_eq!(add_cjk_spaces("总共3个"), "总共 3 个");
    }
}
