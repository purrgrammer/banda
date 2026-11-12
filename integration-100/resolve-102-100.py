"""Resolve the merge of PR #102 (conditional reads) with PR #100 (tail reads): keep both sides; one read rank; the
reuse check before the tail read; `made` recorded only after a complete tail read (never refused, never behind)."""
import re
def resolve(path, fn):
    s=open(path).read()
    out=[];last=0
    for i,m in enumerate(re.finditer(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> origin/fix/issue-34-watch-pagination\n', s, re.S)):
        out.append(s[last:m.start()]); out.append(fn(i,m.group(1),m.group(2))); last=m.end()
    out.append(s[last:]); s=''.join(out)
    assert '<<<<<<<' not in s, path
    open(path,'w').write(s)
resolve('src/core/objects.ts', lambda i,a,b: a+b)
resolve('src/core/definitions.ts', lambda i,a,b: a+"\t\t\t),\n\t\t),\n"+b)
def w(i,a,b):
    if i!=2: return a+b
    a=re.sub(r'\t\t// the paged read first.*?for \(const \[as, read\] of order\) \{\n','',a,flags=re.S)
    b=re.sub(r'\t\t// the paged read first.*?for \(const \[as, read\] of order\) \{\n','',b,flags=re.S)
    tail_end='''				answers[as] = list;
				continue;'''
    assert b.count(tail_end)==1
    b=b.replace(tail_end,'''				answers[as] = list;
				// a complete tail read is made: never one refused, nor one behind (its list stands as last read)
				if (read.unless !== undefined) made[as] = madeNow(read.unless, answers, base, now);
				continue;''')
    hd, hl = a.split('\t\tif (read.unless !== undefined && base !== undefined) {',1)
    td, tl = b.split('\t\t\tif (read.tail !== undefined) {',1)
    return (hd+td+'''		// the paged read first: while its walk has not reached the window, the others wait for the look that merges; the
		// tail reads and a read an `unless` guards last, after the reads that give their counts and their `same`
		const rank = (read: ObjectRead) =>
			read.pages !== undefined ? 0 : read.tail !== undefined || read.unless !== undefined ? 2 : 1;
		const order = Object.entries(shared === undefined ? reads : {}).sort(([, a], [, b]) => rank(a) - rank(b));
		for (const [as, read] of order) {
			// first whether its kept answer may be carried; then, when it is read, the tail's own pages
			if (read.unless !== undefined && base !== undefined) {'''+hl+'\t\t\t}\n\t\t\tif (read.tail !== undefined) {'+tl)
resolve('src/core/watches.ts', w)
p='docs/watches.md'; s=open(p).read()
m=re.search(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> origin/fix/issue-34-watch-pagination\n', s, re.S)
a,b=m.group(1),m.group(2)
mine=a[a.index('- [x] Reads cost'):]
theirs=b[:b.index('- [ ] Reads cost')] if '- [ ] Reads cost' in b else b
s=s[:m.start()]+theirs+mine+s[m.end():]; open(p,'w').write(s)
