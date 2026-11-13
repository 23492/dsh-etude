#!/usr/bin/env python3
"""Deterministic steps between the agent stages of a certification deck (see ../SKILL.md).

Usage: python3 stage.py <command> <project-dir> [args]

  ladder-in            parts/DD/*.json -> ladder/in/DD.json (concept items that need a recognize rung)
  balance-in [--all]   ladder/out + own exam MCQs -> balance/in/DD.json (only questions with a length cue,
                       unless --all); official/bank questions are left alone
  analysis-in          parts -> analysis/in/DD.json (MCQs with their topic's concept cards) for references/analysis.md
  holdout              analysis/out/*.json -> repair/holdout.json: blueprint-weighted mock exams (cert.json mocks)
  repair-in            parts + analysis + holdout -> repair/in/DD.json for references/repair.md
  decoys-in            built pack -> decoys/in/DD.json (fill-in and typed items: the word-bank rung needs tricky
                       wrong blocks, references/decoys.md)
  gaps-in              built pack -> gaps/in/DD.json (word-bank sentences with 2+ gaps: which gaps may trade
                       their blocks, references/decoys.md "Gaps that may swap")
  measure              length-cue report over every MCQ the pack will contain (target: correct strictly
                       longest <= 30%, median correct/wrong ratio 0.9 to 1.1)
  check <stage>        validate the outputs of ladder|balance|repair|lessons|parts

Question bank: cert.json paths.questions, {questions:[{id, domain, domain_name, type: open|mc, question, options,
correct, answer, explanation, priority, status, source, source_id}]}.
"""
import json, glob, os, re, sys, statistics, collections, random

def load(fp, default=None):
    return json.load(open(fp)) if os.path.exists(fp) else default

def dump(obj, fp):
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    json.dump(obj, open(fp, "w"), indent=1, ensure_ascii=False)

if len(sys.argv) < 3:
    raise SystemExit(__doc__)
CMD, ROOT = sys.argv[1], os.path.abspath(sys.argv[2])
ARGS = sys.argv[3:]
C = load(os.path.join(ROOT, "cert.json"))
if not C: raise SystemExit(f"no cert.json in {ROOT}")
P = C.get("ids", {}).get("items", "cert")
Q = {q["id"]: q for q in load(os.path.normpath(os.path.join(ROOT, C["paths"]["questions"])))["questions"]}
DOMS = [d["id"] for d in C["domains"]]
WEIGHT = {d["id"]: d.get("weight", 0) for d in C["domains"]}
slug = lambda s: re.sub(r"[^a-z0-9-]", "", s.lower())
OFFICIAL = lambda s: s.startswith("vragenbank:") or s.startswith("bank:") or s in ("trailhead", "official")

def parts(dd):
    for fp in sorted(glob.glob(os.path.join(ROOT, "parts", dd, "*.json"))):
        yield f"{dd}/{os.path.basename(fp)}", json.load(open(fp))

def cue(options):
    """(correct strictly longest, ratio correct/mean wrong, spread max/min) for one MCQ, by characters."""
    L = [len(o["text"]) for o in options]
    c = [l for l, o in zip(L, options) if o.get("correct")]
    w = [l for l, o in zip(L, options) if not o.get("correct")]
    if not c or not w: return None
    m = max(L)
    return (L.count(m) == 1 and options[L.index(m)].get("correct"), statistics.mean(c) / statistics.mean(w), m / max(1, min(L)), max(L) < 25)

def has_cue(options):
    r = cue(options)
    return bool(r) and not r[3] and (r[0] and r[1] > 1.25 or r[2] > 1.4)

if CMD == "ladder-in":
    for dd in DOMS:
        out = []
        for tf, part in parts(dd):
            for it in part["items"]:
                if it["type"] in ("basic", "cloze", "typed", "free", "match", "order"):
                    out.append({"id": f"{P}.d{dd}.{slug(part['slug'])}.{it['key']}", "kind": it["type"], "fields": it["fields"]})
        dump(out, os.path.join(ROOT, "ladder", "in", f"{dd}.json"))
        print(dd, len(out), "items")

elif CMD == "balance-in":
    lad = {}
    for fp in glob.glob(os.path.join(ROOT, "ladder", "out", "*.json")): lad.update(load(fp))
    for dd in DOMS:
        out = []
        for tf, part in parts(dd):
            for it in part["items"]:
                iid = f"{P}.d{dd}.{slug(part['slug'])}.{it['key']}"
                r = lad.get(iid, {}).get("recognize")
                if r and ("--all" in ARGS or has_cue(r["options"])):
                    out.append({"ref": f"herken|{iid}", "prompt": r["prompt"], "options": r["options"], "explanation": r.get("explanation", ""), "multiple": False})
                if it["type"] == "mcq" and not any(OFFICIAL(Q[c]["source"]) for c in it["covers"] if c in Q):
                    f = it["fields"]
                    if "--all" in ARGS or has_cue(f["options"]):
                        out.append({"ref": f"examen|{tf}|{it['key']}", "prompt": f["prompt"], "options": f["options"], "explanation": f.get("explanation", ""), "multiple": bool(f.get("multiple"))})
        dump(out, os.path.join(ROOT, "balance", "in", f"{dd}.json"))
        print(dd, len(out), "questions to balance")

elif CMD == "analysis-in":
    for dd in DOMS:
        topics = []
        for tf, part in parts(dd):
            topics.append({"topic_file": tf, "topic": part["topic"],
                           "concepts": [{"key": i["key"], "type": i["type"], "fields": i["fields"]} for i in part["items"] if i["type"] != "mcq"],
                           "exams": [{"key": i["key"], "qid": i["covers"][0], "source": Q[i["covers"][0]]["source"], "status": Q[i["covers"][0]].get("status", "ok"), "fields": i["fields"]} for i in part["items"] if i["type"] == "mcq"]})
        dump({"domain": dd, "topics": topics}, os.path.join(ROOT, "analysis", "in", f"{dd}.json"))
        print(dd, sum(len(t["exams"]) for t in topics), "MCQs")

elif CMD == "holdout":
    A = {}
    for fp in sorted(glob.glob(os.path.join(ROOT, "analysis", "out", "*.json"))):
        for q in load(fp)["questions"]: A[q["id"]] = q
    M = C.get("mocks", {"count": 2, "size": 60})
    n, size = M.get("count", 2), M.get("size", C["exam"].get("questions", 60))
    total = sum(WEIGHT.values()) or 1
    quota = {d: round(size * WEIGHT[d] / total) for d in DOMS}
    while sum(quota.values()) != size:  # fix rounding on the heaviest domain
        d = max(DOMS, key=lambda x: WEIGHT[x]); quota[d] += 1 if sum(quota.values()) < size else -1
    rng = random.Random(M.get("seed", 201))
    def score(q):
        s = {"analyze": 3, "apply": 2}.get(q.get("level"), 0) + (1 if q.get("coverage") == "covered" else 0)
        s += 1 if OFFICIAL(Q.get(q["id"], {}).get("source", "")) else 0
        s -= 1 if q.get("correct_longest_unique") else 0
        return s + rng.random() * 0.5
    used_clusters, mocks = set(), {f"proef{i}": [] for i in range(1, n + 1)}
    pool = [q for q in A.values() if not q.get("quality_type") and Q.get(q["id"], {}).get("status", "ok") == "ok" and q.get("level") in ("apply", "analyze")]
    short = []
    for d in DOMS:
        cand = sorted([q for q in pool if q["id"].split("-")[0] == d or Q.get(q["id"], {}).get("domain") == d], key=score, reverse=True)
        per_topic = collections.Counter()
        picked = []
        for q in cand:
            if len(picked) >= quota[d] * n: break
            if q.get("cluster") and q["cluster"] in used_clusters: continue
            if per_topic[q.get("topic_file")] >= max(2, (quota[d] * n) // 3 + 1): continue
            picked.append(q["id"]); per_topic[q.get("topic_file")] += 1
            if q.get("cluster"): used_clusters.add(q["cluster"])
        if len(picked) < quota[d] * n: short.append((d, len(picked), quota[d] * n))
        for i, qid in enumerate(picked): mocks[f"proef{i % n + 1}"].append(qid)
    # Questions in the same cluster as a mock question leave the practice pool (they would leak the answer).
    mates = sorted({x["id"] for x in A.values() if x.get("cluster") and x["cluster"] in used_clusters} - {q for v in mocks.values() for q in v})
    dump({**mocks, "cluster_mates_in_practice": mates, "quota": quota}, os.path.join(ROOT, "repair", "holdout.json"))
    print({k: len(v) for k, v in mocks.items()}, "quota per mock", quota, "short:", short or "none", "cluster mates:", len(mates))

elif CMD == "repair-in":
    A = {}
    for fp in sorted(glob.glob(os.path.join(ROOT, "analysis", "out", "*.json"))):
        a = load(fp)
        for q in a["questions"]: A[q["id"]] = q
    gaps_all = {}
    for fp in sorted(glob.glob(os.path.join(ROOT, "analysis", "out", "*.json"))): gaps_all.update(load(fp).get("gaps", {}))
    H = load(os.path.join(ROOT, "repair", "holdout.json"), {})
    role_of = {q: k for k, v in H.items() if k.startswith("proef") for q in v}
    mates = set(H.get("cluster_mates_in_practice", []))
    # Same-fact duplicates: keep the best one of each cluster in practice, drop the rest.
    drop = {}
    clusters = collections.defaultdict(list)
    for q in A.values():
        if q.get("cluster") and q.get("cluster_kind", "same fact") == "same fact": clusters[q["cluster"]].append(q["id"])
    for cl, ids in clusters.items():
        if any(i in role_of for i in ids): continue
        keep = sorted(ids, key=lambda i: (not OFFICIAL(Q[i]["source"]), i))[0]
        for i in ids:
            if i != keep: drop[i] = f"duplicate of {keep}"
    for i in mates:
        if i not in role_of: drop.setdefault(i, "same cluster as a mock exam question")
    dump(drop, os.path.join(ROOT, "repair", "drop.json"))
    lad = {}
    for fp in glob.glob(os.path.join(ROOT, "ladder", "out", "*.json")): lad.update(load(fp))
    bal = {}
    for fp in glob.glob(os.path.join(ROOT, "balance", "out", "*.json")): bal.update(load(fp))
    for dd in DOMS:
        concepts, exams, gaps = [], [], {}
        for tf, part in parts(dd):
            for it in part["items"]:
                if it["type"] != "mcq":
                    concepts.append({"topic_file": tf, "topic": part["topic"], "key": it["key"], "type": it["type"], "fields": it["fields"], "covers": it["covers"]})
                    continue
                qid = it["covers"][0]
                a = A.get(qid, {})
                ref = f"{tf}|{it['key']}"
                f = dict(it["fields"])
                if f"examen|{ref}" in bal: f["options"] = [{**o, "text": n["text"], "why": n["why"]} for o, n in zip(f["options"], bal[f"examen|{ref}"]["options"])]
                exams.append({"ref": ref, "qid": qid, "topic": part["topic"], "role": role_of.get(qid) or ("drop" if qid in drop else "practice"), "drop_reason": drop.get(qid, ""),
                              "source": Q[qid]["source"], "level": a.get("level", ""), "coverage": a.get("coverage", ""), "coverage_note": a.get("coverage_note", ""),
                              "quality_type": a.get("quality_type", ""), "quality_issue": a.get("quality_issue", ""), "rebalanced": f"examen|{ref}" in bal, "fields": f})
            if tf in gaps_all: gaps[tf] = gaps_all[tf]
        dump({"domain": dd, "concepts": concepts, "exams": exams, "gaps": gaps}, os.path.join(ROOT, "repair", "in", f"{dd}.json"))
        print(dd, len(concepts), "concepts", collections.Counter(e["role"] for e in exams))

elif CMD == "decoys-in":
    pk = load(os.path.join(ROOT, C["paths"].get("pack", "deck.pack.json")))
    if not pk: raise SystemExit("build the pack first (build_pack.py --allow-gaps)")
    T = C.get("ids", {}).get("types", "cl")
    rx = re.compile(r"\{\{([\s\S]+?)\}\}")
    done = {}
    for fp in glob.glob(os.path.join(ROOT, "decoys", "out", "*.json")): done.update(load(fp))
    per = collections.defaultdict(list)
    for it in pk["items"]:
        if it.get("archived"): continue
        f = it["fields"]
        if it["type"] in (f"{T}-begrip", f"{T}-cloze") and rx.search(f.get("text") or ""):
            answers = [m.split("::")[0].split("|") for m in rx.findall(f["text"])]
            entry = {"id": it["id"], "sentence": f["text"], "blanks": [[a.strip() for a in x] for x in answers], "context": f.get("front") or f.get("explanation") or ""}
        elif it["type"] == f"{T}-typed":
            entry = {"id": it["id"], "sentence": f["prompt"] + " {{" + "|".join(f["answers"]) + "}}", "blanks": [f["answers"]], "context": f.get("explanation", "")}
        else: continue
        # A decoy that also stands as plain words in the sentence is ruled out at a glance: redo those too.
        plain = rx.sub(" ", entry["sentence"]).lower()
        seen = [d for d in f.get("decoys", []) if re.search(r"(?<!\w)" + re.escape(str(d).lower()) + r"(?!\w)", plain)]
        if "--all" not in ARGS and it["id"] in done and not seen: continue
        if seen: entry["redo"] = f"these decoys stand as plain words in the sentence: {seen}"
        m = re.match(rf"{re.escape(P)}\.d(\w+?)\.", it["id"])
        per[m.group(1) if m else "xx"].append({**entry, "topic": it["deck"].split("::")[-1]})
    for dd in DOMS:
        dump(per.get(dd, []), os.path.join(ROOT, "decoys", "in", f"{dd}.json"))
        print(dd, len(per.get(dd, [])), "items need decoys")

elif CMD == "gaps-in":
    pk = load(os.path.join(ROOT, C["paths"].get("pack", "deck.pack.json")))
    if not pk: raise SystemExit("build the pack first")
    T = C.get("ids", {}).get("types", "cl")
    rx = re.compile(r"\{\{([\s\S]+?)\}\}")
    done = {}
    for fp in glob.glob(os.path.join(ROOT, "gaps", "out", "*.json")): done.update(load(fp))
    per = collections.defaultdict(list)
    for it in pk["items"]:
        f = it["fields"]
        if it.get("archived") or it["type"] not in (f"{T}-begrip", f"{T}-cloze") or len(rx.findall(f.get("text") or "")) < 2: continue
        if "--all" not in ARGS and it["id"] in done: continue
        m = re.match(rf"{re.escape(P)}\.d(\w+?)\.", it["id"])
        per[m.group(1) if m else "xx"].append({"id": it["id"], "question": f.get("front", ""), "answer": f.get("back") or f.get("explanation", ""), "text": f["text"], "decoys": f.get("decoys", [])})
    for dd in DOMS:
        dump(per.get(dd, []), os.path.join(ROOT, "gaps", "in", f"{dd}.json"))
        print(dd, len(per.get(dd, [])), "multi-gap sentences")

elif CMD == "measure":
    lad, bal, rep = {}, {}, {}
    for fp in glob.glob(os.path.join(ROOT, "ladder", "out", "*.json")): lad.update(load(fp))
    for fp in glob.glob(os.path.join(ROOT, "balance", "out", "*.json")): bal.update(load(fp))
    for fp in glob.glob(os.path.join(ROOT, "repair", "out", "*.json")): rep.update(load(fp).get("exams", {}))
    groups = collections.defaultdict(list)
    for dd in DOMS:
        for tf, part in parts(dd):
            for it in part["items"]:
                iid = f"{P}.d{dd}.{slug(part['slug'])}.{it['key']}"
                r = lad.get(iid, {}).get("recognize")
                if r: groups["recognize"].append(bal.get(f"herken|{iid}", r)["options"])
                if it["type"] == "mcq":
                    ref = f"{tf}|{it['key']}"
                    opts = bal.get(f"examen|{ref}", it["fields"])["options"]
                    x = rep.get(ref, {})
                    if x.get("action") == "retire": continue
                    if x.get("action") == "fix" and x.get("fields"): opts = x["fields"]["options"]
                    src = "official" if any(OFFICIAL(Q[c]["source"]) for c in it["covers"] if c in Q) else "own"
                    if sum(1 for o in opts if o.get("correct")) == 1: groups[f"exam {src}"].append(opts)
    for g, L in sorted(groups.items()):
        rs = [cue(o) for o in L]; rs = [r for r in rs if r]
        if not rs: continue
        longest = sum(1 for r in rs if r[0]) / len(rs)
        print(f"{g:15} n={len(rs):4}  correct strictly longest {longest:5.1%} (target <= 30%)  median ratio {statistics.median(r[1] for r in rs):.2f} (0.9-1.1)  spread > 1.4: {sum(1 for r in rs if r[2] > 1.4 and not r[3])}")

elif CMD == "check":
    stage = ARGS[0] if ARGS else ""
    bad = []
    dash = lambda s: "\u2014" in s or "\u2013" in s
    if stage == "parts":
        covered = set()
        for dd in DOMS:
            for tf, part in parts(dd):
                keys = set()
                for it in part["items"]:
                    if it["key"] in keys: bad.append(f"{tf}: duplicate key {it['key']}")
                    keys.add(it["key"]); covered.update(it["covers"])
                    if dash(json.dumps(it, ensure_ascii=False)): bad.append(f"{tf} {it['key']}: dash")
                    if it["type"] == "match":
                        rs = [r for _, r in it["fields"].get("pairs", [])]
                        if len(rs) != len(set(rs)): bad.append(f"{tf} {it['key']}: repeated right side")
        miss = sorted(set(Q) - covered)
        if miss: bad.append(f"{len(miss)} source questions not covered: {miss[:30]}")
    elif stage == "ladder":
        for dd in DOMS:
            want = [x["id"] for x in load(os.path.join(ROOT, "ladder", "in", f"{dd}.json"), []) if x["kind"] in ("basic", "cloze", "typed", "free")]
            out = load(os.path.join(ROOT, "ladder", "out", f"{dd}.json"), {})
            for i in want:
                c = out.get(i)
                if not c: bad.append(f"{i}: missing"); continue
                r = c.get("recognize") or {}
                o = r.get("options", [])
                if len(o) != 4 or sum(1 for x in o if x.get("correct")) != 1: bad.append(f"{i}: needs 4 options, one correct")
                if any(not x.get("why", "").strip() for x in o): bad.append(f"{i}: option without why")
                if len({x["text"] for x in o}) != len(o): bad.append(f"{i}: duplicate option text")
                t = c.get("text")
                if t is not None and not (1 <= len(re.findall(r"\{\{.+?\}\}", t)) <= 3): bad.append(f"{i}: text needs 1 to 3 blanks")
                if dash(json.dumps(c, ensure_ascii=False)): bad.append(f"{i}: dash")
    elif stage == "balance":
        for dd in DOMS:
            q = load(os.path.join(ROOT, "balance", "in", f"{dd}.json"), [])
            o = load(os.path.join(ROOT, "balance", "out", f"{dd}.json"), {})
            for x in q:
                n = o.get(x["ref"])
                if not n: bad.append(f"{x['ref']}: missing"); continue
                a, b = x["options"], n["options"]
                if len(a) != len(b) or [bool(p.get("correct")) for p in a] != [bool(p.get("correct")) for p in b]: bad.append(f"{x['ref']}: options or correct flags changed")
                if any(not p.get("why", "").strip() for p in b): bad.append(f"{x['ref']}: option without why")
    elif stage == "repair":
        refs = {}
        for dd in DOMS:
            for tf, part in parts(dd):
                for it in part["items"]:
                    if it["type"] != "mcq": refs[f"{tf}|{it['key']}"] = 1
        outs = {dd: load(os.path.join(ROOT, "repair", "out", f"{dd}.json"), {}) for dd in DOMS}
        for dd, r in outs.items():
            for c in r.get("new_concepts", []): refs[f"{c['topic_file']}|{c['key']}"] = 1
        for dd in DOMS:
            inp = load(os.path.join(ROOT, "repair", "in", f"{dd}.json"), {"exams": []})
            ex = outs[dd].get("exams", {})
            for e in inp["exams"]:
                d = ex.get(e["ref"])
                if not d: bad.append(f"{e['ref']}: no decision"); continue
                if d["action"] in ("keep", "fix"):
                    t = d.get("teaches") or []
                    if not 1 <= len(t) <= 3: bad.append(f"{e['ref']}: needs 1 to 3 teaches")
                    for x in t:
                        if x not in refs: bad.append(f"{e['ref']}: teaches unknown {x}")
                if d["action"] == "fix":
                    o = (d.get("fields") or {}).get("options", [])
                    if len(o) != len(e["fields"]["options"]) or not any(x.get("correct") for x in o): bad.append(f"{e['ref']}: fix changes option count or has no correct option")
                if e["role"].startswith("proef") and d["action"] == "retire": bad.append(f"{e['ref']}: mock question retired (pick another holdout)")
    elif stage == "lessons":
        lo, hi = C.get("lessonWords", [150, 280])
        for dd in DOMS:
            L = load(os.path.join(ROOT, "lessons", f"{dd}.json"), {})
            for tf, part in parts(dd):
                k = tf.split("/")[1][:-5]
                if k not in L: bad.append(f"{tf}: no lesson"); continue
                w = len(L[k].split())
                if not lo <= w <= hi: bad.append(f"{tf}: {w} words (want {lo} to {hi})")
                if dash(L[k]): bad.append(f"{tf}: dash")
    elif stage == "decoys":
        low = lambda x: re.sub(r"\s+", " ", str(x).strip().lower())
        for dd in DOMS:
            want = load(os.path.join(ROOT, "decoys", "in", f"{dd}.json"), [])
            out = load(os.path.join(ROOT, "decoys", "out", f"{dd}.json"), {})
            for x in want:
                d = (out.get(x["id"]) or {}).get("decoys")
                if not d: bad.append(f"{x['id']}: missing"); continue
                rights = {low(a) for b in x["blanks"] for a in b}
                if not 4 <= len(d) <= 8: bad.append(f"{x['id']}: needs 4 to 8 decoys, has {len(d)}")
                if len({low(a) for a in d}) != len(d): bad.append(f"{x['id']}: duplicate decoy")
                if any(low(a) in rights for a in d): bad.append(f"{x['id']}: decoy equals a right answer")
                plain = re.sub(r"\{\{[\s\S]+?\}\}", " ", x["sentence"]).lower()
                if any(re.search(r"(?<!\w)" + re.escape(low(a)) + r"(?!\w)", plain) for a in d): bad.append(f"{x['id']}: decoy stands as plain words in the sentence")
                if dash(json.dumps(d, ensure_ascii=False)): bad.append(f"{x['id']}: dash")
    elif stage == "gaps":
        rx = re.compile(r"\{\{([\s\S]+?)\}\}")
        for dd in DOMS:
            want = {x["id"]: x for x in load(os.path.join(ROOT, "gaps", "in", f"{dd}.json"), [])}
            out = load(os.path.join(ROOT, "gaps", "out", f"{dd}.json"), {})
            for i, x in out.items():
                if want and i not in want: bad.append(f"{i}: not a multi-gap sentence in gaps/in"); continue
                n = len(rx.findall(want[i]["text"])) if i in want else 0
                g = x.get("swap")
                if not isinstance(g, list) or not g: bad.append(f"{i}: swap must be a list of groups"); continue
                seen = set()
                for grp in g:
                    if not isinstance(grp, list) or len(grp) < 2 or any(not isinstance(k, int) or not 0 <= k < n for k in grp): bad.append(f"{i}: bad group {grp} ({n} gaps)")
                    elif seen & set(grp): bad.append(f"{i}: gap in two groups")
                    else: seen |= set(grp)
    else:
        raise SystemExit("check what? parts | ladder | balance | repair | lessons | decoys | gaps")
    print("\n".join(bad) if bad else f"{stage}: OK")
    sys.exit(1 if bad else 0)
else:
    raise SystemExit(__doc__)
