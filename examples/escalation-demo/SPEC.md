# Regex Engine Spec

Implement `search(pattern: str, text: str) -> tuple[int, int] | None` in `engine.py`.

Return the span of the leftmost match, exactly like `re.search(...).span()`, or `None`
when there is no match. Semantics must match Python's `re` module.

You MUST write a real backtracking engine yourself. Do NOT import `re`, `regex`, `sre_`,
`fnmatch`, or any other pattern-matching library, and do not shell out to `grep`. Any
solution that delegates the matching to an existing engine is rejected.

Required syntax:

1. Literals, and `.` matching any character except newline.
2. Anchors `^` and `$`.
3. Character classes `[abc]`, ranges `[a-c]`, negation `[^a-c]`, and a literal `.`
   inside a class.
4. Escapes `\d`, `\w`, `\s`, `\b`, and escaped punctuation such as `\.`.
5. Quantifiers `*`, `+`, `?`, and `{m}`, `{m,}`, `{m,n}`.
6. Lazy quantifiers `*?`, `+?`, `??`.
7. Alternation `a|b`, with correct leftmost-then-earliest-alternative preference.
8. Capturing groups `(...)`, non-capturing groups `(?:...)`, and backreferences `\1`..`\9`.

Leftmost semantics matter: try each start offset in order, and at a given start prefer
the earliest alternative and the greedy/lazy behavior of each quantifier, exactly as a
backtracking engine does. `(foo|foobar)baz` against `foobarbaz` must still match.

A quantified group that can match empty must not loop forever: `(a?)*b` must terminate.

Run `python3 -m pytest -q` to check your work. All 32 tests must pass.
