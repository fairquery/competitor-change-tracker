# Minimal "did this page's text change?" check: polite, robots-aware, standard library only.
import hashlib, json, os, re, sys, urllib.error, urllib.request, urllib.robotparser
from html.parser import HTMLParser
from urllib.parse import urlsplit

UA = "MyChangeCheck/0.1 (+mailto:you@example.com)"
url = sys.argv[1]                      # e.g. https://basecamp.com/about/policies/terms

base = "{0.scheme}://{0.netloc}".format(urlsplit(url))
rp = urllib.robotparser.RobotFileParser()
try:   # fetch robots.txt with our own user agent; a 4xx means no rules
    rp.parse(urllib.request.urlopen(urllib.request.Request(base + "/robots.txt", headers={"User-Agent": UA}), timeout=20).read().decode("utf-8", "replace").splitlines())
except urllib.error.HTTPError as e:
    if e.code >= 500: sys.exit("robots.txt unavailable; not fetching")
    rp.parse([])
if not rp.can_fetch(UA, url):
    sys.exit("robots.txt disallows " + url)

class Text(HTMLParser):
    skip, out = 0, []
    def handle_starttag(self, t, a): self.skip += t in ("script", "style", "nav", "footer")
    def handle_endtag(self, t): self.skip -= t in ("script", "style", "nav", "footer") and self.skip > 0
    def handle_data(self, d):
        if not self.skip and d.strip(): self.out.append(d.strip())

html = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=20).read().decode("utf-8", "replace")
p = Text(); p.feed(html)
text = re.sub(r"\b(19|20)\d\d-\d\d-\d\d\b|\b\d{1,2}:\d\d\b", "", "\n".join(p.out))   # drop dates/times
digest = hashlib.sha256(text.encode()).hexdigest()

state = json.load(open("state.json")) if os.path.exists("state.json") else {}
print("baseline" if url not in state else ("unchanged" if state[url] == digest else "CHANGED"))
state[url] = digest; json.dump(state, open("state.json", "w"))
