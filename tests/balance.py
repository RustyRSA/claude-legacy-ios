import sys, re
def strip(src):
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i); i = n if j < 0 else j; continue
        if src.startswith("/*", i):
            j = src.find("*/", i + 2); i = n if j < 0 else j + 2; continue
        if c in "\"'":
            q = c; i += 1
            while i < n and src[i] != q:
                i += 2 if src[i] == "\\" else 1
            i += 1; continue
        out.append(c); i += 1
    return "".join(out)
for path in sys.argv[1:]:
    s = strip(open(path).read())
    print(path.split("/")[-3] + "/" + path.split("/")[-1], " ".join(f"{o}{c} {s.count(o)}/{s.count(c)}" for o, c in ["{}", "()", "[]"]))
