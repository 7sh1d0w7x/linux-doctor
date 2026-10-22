# Case study: "No space left on device" with 56 MB free

> **This is a lab, not an incident report.** Everything below was reproduced on a
> throwaway 64 MB filesystem living in a file under `/tmp`, on one machine, in a
> few minutes. The paths are not real ones and no user was involved. What it
> shows is how to read one finding and confirm it yourself — the report is a
> starting point, not a verdict.

## The symptom

An application stops being able to write. It reports:

```
write probe: errno 28: No space left on device
```

And the obvious thing to check says there is plenty of room:

```
Filesystem              Size  Used Avail Use% Mounted on
/tmp/inode-lab/lab.ext4  64M  5.4M   56M   9% /tmp/inode-lab/mnt
```

That combination — a write failure with free space — is the whole reason this
case is worth writing down. The second command people reach for explains it.

## The lab

A 64 MB ext4 image with a deliberately tiny inode table (320 inodes, of which 12
are used by the filesystem itself), mounted without root through `fuse2fs`, then
filled with empty files until it refuses.

```bash
LAB=/tmp/inode-lab
mkdir -p "$LAB/mnt"
truncate -s 64M "$LAB/lab.ext4"
# -N 300 is the point of the lab: a default 64 MB ext4 gets 16384 inodes.
mkfs.ext4 -q -N 300 -E root_owner=$(id -u):$(id -g) -F "$LAB/lab.ext4"
fuse2fs -o fsname=inode-lab "$LAB/lab.ext4" "$LAB/mnt"

# 308 files fit; the 309th is refused.
for i in $(seq 1 400); do : > "$LAB/mnt/file-$i" || break; done
```

`fuse2fs` prints a warning that it does not support the journal. That is true,
and it does not matter here: the inode counts come from the ext4 superblock,
which is what `df -i` reads.

## What Linux Doctor reports

`linux-doctor` (here: `node bin/doctor.js` from a checkout, 0.8.0) puts the
finding first, because a filesystem that cannot accept writes outranks almost
everything else:

```
▶ START HERE   #1 Partition /tmp/inode-lab/mnt has almost no free inodes
             Find what is eating inodes with `sudo find /tmp/inode-lab/mnt -xdev -type f | cut -d/ -f3 | sort | uniq -c |…

🔴 HIGH
-------

1. [system] Partition /tmp/inode-lab/mnt has almost no free inodes
   The partition at /tmp/inode-lab/mnt has 100% of its inodes in use. New files cannot be created even though disk space may still be free — this is the classic cause of "No space left on device" with free space showing in df -h.
```

The one-line summary:

```
health 85/100 · delta=-15 · new=1 · unchanged=33 · high=1 · info=33
```

And the machine-readable form, which is what a script or the dashboard consumes:

```json
{
  "code": "inodes/full",
  "severity": "high",
  "confidence": "high",
  "title": "Partition /tmp/inode-lab/mnt has almost no free inodes",
  "evidence": "/tmp/inode-lab/lab.ext4      320   320        0  100% /tmp/inode-lab/mnt"
}
```

## Confirming it by hand

Two commands, and no trust in the tool required.

```bash
$ df -h /tmp/inode-lab/mnt
Filesystem              Size  Used Avail Use% Mounted on
/tmp/inode-lab/lab.ext4  64M  5.4M   56M   9% /tmp/inode-lab/mnt

$ df -i /tmp/inode-lab/mnt
Filesystem             Inodes IUsed IFree IUse% Mounted on
/tmp/inode-lab/lab.ext4    320   320     0  100% /tmp/inode-lab/mnt
```

Counting the objects directly gives the same answer, without a table to parse:

```bash
$ find /tmp/inode-lab/mnt -xdev -type f | wc -l
308
$ du --inodes -s /tmp/inode-lab/mnt
310	/tmp/inode-lab/mnt
```

308 files plus two directories is 310 objects — and `df -i` says 320 of 320 used,
because the filesystem also had 12 inodes in use before anything was written.

Worth noticing: the `evidence` field in the JSON is *literally the `df -i` line*
the tool read. The finding does not ask you to believe a number it computed — it
shows you its source, so you can check it.

## Why inodes are the cause

An ext4 filesystem is created with a **fixed inode table**. Every file and every
directory consumes exactly one inode, forever; you cannot add more without
reformatting. `mkfs.ext4 -N 300` asked for 300 and got 320 (the tool rounds up to
fit its block groups), so this filesystem can hold about 300 objects no matter
how small they are.

Two counters therefore exist, and they fail independently:

| counter | what it measures | in this lab |
|---|---|---|
| blocks | bytes on disk | 9% used — 56 MB free |
| inodes | number of objects | **100% used — 0 free** |

`df -h` reports the first. `df -i` reports the second. An application that cannot
create a file needs *both* a free block and a free inode, and when the second one
is missing the kernel returns `ENOSPC` — the same error it returns for a full
disk, which is why the message says "no space left" while 56 MB sit unused.

The 308 files in this lab occupy 17 KB of actual data. Space was never the
problem; *count* was.

This is not a contrived-only situation. It is what happens on a real machine
when one directory accumulates millions of tiny files: a maildir, a package
cache, `node_modules` trees, session files, thumbnail caches, or a runaway log
rotator. The filesystem is empty by weight and full by number.

## The fix, and how to know it worked

In the lab, the fix is to remove what is consuming the inodes:

```bash
$ rm -f /tmp/inode-lab/mnt/file-*
$ df -i /tmp/inode-lab/mnt
Filesystem             Inodes IUsed IFree IUse% Mounted on
/tmp/inode-lab/lab.ext4    320    12   308    4% /tmp/inode-lab/mnt

$ python3 -c "open('/tmp/inode-lab/mnt/probe','w').write('ok'); print('write probe: ok')"
write probe: ok

$ linux-doctor --summary
health 100/100 · delta=+15 · fixed=1 · unchanged=33 · info=33
```

Three separate confirmations, in increasing order of directness: the counter
dropped, the operation that used to fail now succeeds, and the report agrees.
The `fixed=1` and the `+15` are the tool comparing this run to the previous one —
it knows the finding was there before and is gone now.

On a real machine the first step is finding *which* directory is eating inodes.
The tool suggests:

```bash
sudo find /mnt -xdev -type f | cut -d/ -f3 | sort | uniq -c | sort -rn | head -20
```

In the lab that prints one line, because the whole mount is the culprit:

```
    308 inode-lab
```

That command is a heuristic: `cut -d/ -f3` groups by the third path component,
which is the username under `/home/<user>/...` but something else anywhere else.
It points at a directory, not necessarily at the guilty one. `du --inodes -d1`
(GNU coreutils 8.22+) or `find <mount> -xdev -type f | sed "s|^<mount>/||" | cut -d/ -f1 | sort | uniq -c`
are better starting points when the mount is not under `/home`.

## What this case does not prove

- **It is a lab.** A real incident has history, other findings competing for
  attention, and a user who did not choose to have this problem. Nothing here
  says the first finding in a real report is the one that matters.
- **`fuse2fs` is not a real mount.** No journal, and it runs in userspace. The
  inode accounting is the filesystem's own, so the numbers are real; the
  performance and failure modes of a kernel ext4 mount are not reproduced.
- **`stat -f` disagrees with `df -i` here, and `df -i` is right.** At exhaustion
  this mount reports `files=60003 free=60003` through `stat -f` while `df -i`
  reports 0 free — the FUSE layer answers from its own estimate, not from the
  filesystem's counter. On a kernel ext4 mount the two agree. Use this lab to
  learn `df -i`; do not use it to learn `stat -f`.
- **The check has boundaries.** `inodes` skips `tmpfs` and other pseudo
  filesystems by design — their inode counts are not the user's data. On btrfs
  `df -i` is not meaningful (inodes are allocated dynamically), so this check
  reports nothing there, correctly.
- **The tool does not find the culprit.** It tells you the filesystem is out of
  inodes and shows the line it read. Locating the directory that filled it is
  still `find`/`du` work, and the command it suggests is a starting point with
  the limitations described above.
- **It says nothing about whether the application was right to fail.** An
  application that keeps writing tiny files until it exhausts an inode table is
  a bug in the application; the filesystem only reported it.
