import pytest

from engine import search


CASES = [
    ('a*b', 'aaab', (0, 4)),
    ('a+?b', 'aaab', (0, 4)),
    ('(ab)\\1', 'abab', (0, 4)),
    ('(a|b)+c', 'ababc', (0, 5)),
    ('^ab.*z$', 'abxyz', (0, 5)),
    ('[a-c]+', 'xxabcxx', (2, 5)),
    ('[^a-c]+', 'abcxyzabc', (3, 6)),
    ('(a+)(b+)\\2', 'aabbb', (0, 4)),
    ('a??b', 'ab', (0, 2)),
    ('(?:ab)+c', 'ababc', (0, 5)),
    ('\\d+\\w', '123x', (0, 4)),
    ('a.c', 'abc', (0, 3)),
    ('(x?)y\\1', 'yy', (0, 1)),
    ('(a*)*b', 'aaab', (0, 4)),
    ('colou?r', 'color', (0, 5)),
    ('(ab|a)(b?)c', 'abc', (0, 3)),
    ('\\s+x', '  x', (0, 3)),
    ('(a)(b)(c)\\3\\2\\1', 'abccba', (0, 6)),
    ('z|ab', 'xxabz', (2, 4)),
    ('a{0,}b', 'aab', (0, 3)),
    ('a{2,3}', 'aaaa', (0, 3)),
    ('a{2}b', 'aab', (0, 3)),
    ('(a|ab)(c|bcd)', 'abcd', (0, 4)),
    ('x*', 'yyy', (0, 0)),
    ('(a?)*b', 'b', (0, 1)),
    ('[.]', 'a.b', (1, 2)),
    ('a\\.c', 'a.c', (0, 3)),
    ('(foo|foobar)baz', 'foobarbaz', (0, 9)),
    ('\\bcat\\b', 'the cat sat', (4, 7)),
    ('a[bc]?d', 'ad', (0, 2)),
    ('^$', '', (0, 0)),
    ('(a)|b', 'b', (0, 1)),
]


@pytest.mark.parametrize("pattern,text,expected", CASES)
def test_matches_python_re(pattern, text, expected):
    assert search(pattern, text) == expected
