# Case study: "No space left on device" with 56 MB free

> **This is a lab, not an incident report.** Everything below was reproduced on a
> throwaway 64 MB filesystem living in a file under `/tmp`, on one machine, in a
> few minutes. The paths are not real ones and no user was involved. What it
> shows is how to read one finding and confirm it yourself — the report is a
> starting point, not a verdict.

**How to read this page.** Every command below is followed by the output it
actually produced on the run described here — nothing is reconstructed. The
explanation of *why* the numbers look like that is reasoning, and where a claim
comes from a manual or the kernel documentation it is cited as such. The two are
kept apart on purpose: the measurement is what you can reproduce, the
explanation is what you have to decide whether to believe.

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

### Requirements

- A Linux box with `e2fsprogs` (`mkfs.ext4`, `dumpe2fs`, `debugfs`) and
  `fuse2fs` + `fusermount3`.
- **No root.** The filesystem is a plain file mounted through FUSE, so the whole
  lab runs as an ordinary user.
- About 64 MB of scratch space.

### Isolation

Everything lives under a single directory, `/tmp/inode-lab`: the image file
(`lab.ext4`), the mountpoint (`mnt`), and the files created inside it. Nothing
outside that directory is written, and nothing outside it is deleted. The only
other thing this lab runs is `linux-doctor`, which reads.

The filesystem is deliberately tiny and deliberately poor in inodes, which is
the point: a 64 MB image normally gets 16384 inodes, and this one asks for 300.

```bash
LAB=/tmp/inode-lab
mkdir -p "$LAB/mnt"
truncate -s 64M "$LAB/lab.ext4"
mkfs.ext4 -q -N 300 -E root_owner=$(id -u):$(id -g) -F "$LAB/lab.ext4"
fuse2fs -o fsname=inode-lab "$LAB/lab.ext4" "$LAB/mnt"
```

```
FUSE2FS (lab.ext4): Warning: fuse2fs does not support using the journal.
There may be file system corruption or data loss if
the file system is not gracefully unmounted.
```

That warning is real and it matters for the cleanup step at the end. It does not
affect the inode counts: those come from the ext4 superblock, which is what
`df -i` reads.

Before anything is written, the filesystem looks unremarkable:

```bash
df -h "$LAB/mnt" | tail -1
df -i "$LAB/mnt" | tail -1
```

```
/tmp/inode-lab/lab.ext4   64M  5.4M   56M   9% /tmp/inode-lab/mnt
/tmp/inode-lab/lab.ext4    320    12   308    4% /tmp/inode-lab/mnt
```

## Filling it

Empty files are enough. Nothing here writes any data of consequence.

```bash
for i in $(seq 1 400); do : > "$LAB/mnt/file-$i" 2>/dev/null || { echo "first failure at file-$i"; break; }; done
```

```
/bin/bash: line 12: /tmp/inode-lab/mnt/file-309: No space left on device
first failure at file-309
```

Bash prints its own message for the failed redirection — `2>/dev/null` silences
the command, not the shell. The `line 12` is from running the loop as a script.

Now the two counters disagree, and only one of them is about space:

```bash
df -h "$LAB/mnt" | tail -1
df -i "$LAB/mnt" | tail -1
```

```
/tmp/inode-lab/lab.ext4   64M  5.4M   56M   9% /tmp/inode-lab/mnt
/tmp/inode-lab/lab.ext4    320   320     0  100% /tmp/inode-lab/mnt
```

```bash
python3 - <<'PY'
try:
    open("/tmp/inode-lab/mnt/probe", "w").close()
    print("write probe: succeeded")
except OSError as e:
    print("write probe: errno %d: %s" % (e.errno, e.strerror))
PY
```

```
write probe: errno 28: No space left on device
```

## What Linux Doctor reports

In this run it came first — a filesystem that cannot accept writes outranks
almost everything else:

```
▶ START HERE   #1 Partition /tmp/inode-lab/mnt has almost no free inodes
             Find what is eating inodes with `sudo find /tmp/inode-lab/mnt -xdev -type f | cut -d/ -f3 | sort | uniq -c |…

🔴 HIGH
-------

1. [system] Partition /tmp/inode-lab/mnt has almost no free inodes
   The partition at /tmp/inode-lab/mnt has 100% of its inodes in use. New files cannot be created even though disk space may still be free — this is the classic cause of "No space left on device" with free space showing in df -h.
```

The machine-readable form, which is what a script or the dashboard consumes:

```json
{
  "code": "inodes/full",
  "severity": "high",
  "confidence": "high",
  "title": "Partition /tmp/inode-lab/mnt has almost no free inodes",
  "evidence": "/tmp/inode-lab/lab.ext4      320   320        0  100% /tmp/inode-lab/mnt"
}
```

The summary below comes from `--check inodes`, so it reflects only this check and
does not move when the host machine has other findings:

```bash
linux-doctor --check inodes --summary
```

```
health 85/100 · high=1
```

(On the machine this was written on, the full run also carried two unrelated
findings, `services/failed` and `crash/coredumps`, for an overall score of
69/100. Isolating the check is what makes the number here reproducible.)

## Confirming it by hand

No trust in the tool required. The `evidence` field above is *literally the
`df -i` line* the tool read — it does not ask you to believe a number it
computed, it shows you its source.

Counting the objects gives the same answer without a table to parse:

```bash
find "$LAB/mnt" -xdev -type f 2>/dev/null | wc -l
find "$LAB/mnt" -xdev -type d 2>/dev/null | wc -l
```

```
308
2
```

(`2>/dev/null` hides a `Permission denied` from `lost+found`, which `mkfs` creates
as mode 0700 owned by root. The directory is still counted; only its contents
are unreadable.)

## Why inodes are the cause

An ext4 filesystem is created with a **fixed inode table**. `man mke2fs`:

> `-i bytes-per-inode` — Specify the bytes/inode ratio. mke2fs creates an inode
> for every bytes-per-inode bytes of space on the disk. … Be warned that it is
> not possible to change this ratio on a file system after it is created, so be
> careful deciding the correct value for this parameter. Note that resizing a
> file system changes the number of inodes to maintain this ratio.

> `-N number-of-inodes` — Overrides the default calculation of the number of
> inodes that should be reserved for the file system (which is based on the
> number of blocks and the bytes-per-inode ratio).

And the kernel's ext4 documentation
([`Documentation/filesystems/ext4/inodes.rst`](https://www.kernel.org/doc/html/latest/filesystems/ext4/inodes.html)):

> The inode table is a linear array of `struct ext4_inode`. The table is sized to
> have enough blocks to store at least `sb.s_inode_size * sb.s_inodes_per_group`
> bytes. … There is no inode 0.

So `-N 300` asked for 300 and produced 320. The reason is visible in `dumpe2fs`:
the image has 8 block groups, and `mkfs` rounds the request to a whole number of
inodes per group — 300 / 8 = 37.5, rounded to 40, and 8 × 40 = 320. This
filesystem can hold 320 objects, no matter how small they are.

### What consumes an inode — and what does not

The tempting summary, "every file uses an inode forever", is wrong twice over,
and both corrections matter when you go looking for the culprit.

**One inode per object, not per name.** A regular file, a directory, a symbolic
link, a device node, a FIFO and a socket each need one inode — the ext4
documentation linked above lists exactly these as the `i_mode` file types. A
**hard link does not**: it is an extra directory entry pointing at the *same*
inode, so a file with ten hard links is still one inode. `man 7 inode` calls
this field `st_nlink`, "the number of hard links to the file". Directories are a
special case: every subdirectory's `..` entry counts as a hard link to its
parent, as does the `.` entry, which is why the kernel documentation caps ext4
at 64,998 subdirectories in one directory.

**Not forever.** Deleting a name frees the inode for reuse. `man 2 unlink`:

> If that name was the last link to a file and no processes have the file open,
> the file is deleted and the space it was using is made available for reuse.

So inode exhaustion is not a one-way door: the fix is to delete things, and the
freed inodes go back into the pool for the next file. What you *cannot* do is
increase the total — the ratio is fixed at creation, per `man mke2fs` above.

### Where the first 12 inodes went

The filesystem arrived with 12 of its 320 inodes already used, and `find` can
only see two of them. The numbers line up exactly, which is a good sign the
explanation is not hand-waving:

| measurement | value |
|---|---|
| inodes in total | 320 |
| used before anything was written | 12 |
| free before anything was written | 308 |
| files created before `ENOSPC` | 308 |
| used after | 320 |
| objects `find` can see (308 files + 2 directories) | 310 |
| used inodes with no directory entry (320 − 310) | 10 |

```bash
dumpe2fs /tmp/inode-lab/lab.ext4 | grep -E "^First inode|^Orphan file inode|^Journal inode"
```

```
First inode:              11
Journal inode:            8
Orphan file inode:        12
```

- **Inodes 1–10** are reserved for the filesystem itself: `First inode: 11` is
  where user files may start. `debugfs` shows that in this image only three of
  them hold anything — the root directory (2), the resize inode (7) and the
  journal (8); the rest are marked in use but empty.
- **Inode 11** is `lost+found`, which `mkfs` always creates.
- **Inode 12** is the orphan file that the default `orphan_file` feature
  allocates.

Of those twelve, the root directory (inode 2) and `lost+found` (inode 11) have
directory entries, so `find` sees them. The other ten have none — they are the
filesystem's own bookkeeping, and no `find` will ever show them. That is the
whole of the 10-inode difference in the table.

## The fix, and how to know it worked

Removing what is consuming the inodes returns them to the pool:

```bash
rm -f "$LAB"/mnt/file-*
df -i "$LAB/mnt" | tail -1
```

```
/tmp/inode-lab/lab.ext4    320    12   308    4% /tmp/inode-lab/mnt
```

```bash
python3 - <<'PY'
try:
    open("/tmp/inode-lab/mnt/probe", "w").write("ok")
    print("write probe: succeeded")
except OSError as e:
    print("write probe: errno %d: %s" % (e.errno, e.strerror))
PY
rm -f "$LAB/mnt/probe"
linux-doctor --check inodes --summary
```

```
write probe: succeeded
health 100/100
```

Three confirmations, in increasing order of directness: the counter dropped, the
operation that used to fail now succeeds, and the report agrees.

### Finding the culprit on a real machine

The tool suggests this, with the mountpoint it actually found:

```bash
find /tmp/inode-lab/mnt -xdev -type f 2>/dev/null | cut -d/ -f3 | sort | uniq -c | sort -rn | head -20
```

```
    308 inode-lab
```

(`2>/dev/null` again: the tool prints this command for a root shell, where
`lost+found` is readable, but this lab runs unprivileged.)

On a real machine that command is a **heuristic, not an answer**. `cut -d/ -f3`
groups by the third path component — the username under `/home/<user>/…`, but
whatever happens to sit third elsewhere. In this lab it lands on the mount
directory; under `/var/lib/docker/…` it would land on `lib`. It points at a
region, not at the guilty directory.

`du --inodes -d1 <mount>` (GNU coreutils; `du --version` here is 9.10) is
usually the better starting point, since it groups by real depth rather than by
path position. A flat lab does not exercise it well — every file here is one
inode in the same directory — so this page does not pretend to show it working.

## Clean up

**Order matters: unmount first, then delete.** `fuse2fs` runs in userspace with
no journal, so removing the image file while the filesystem is still mounted can
leave it corrupt — the warning printed at mount time is about exactly this.
Unmounting flushes through the FUSE layer; after that the image is just a file.

```bash
fusermount3 -u "$LAB/mnt"
findmnt -no TARGET "$LAB/mnt" >/dev/null 2>&1 && echo "still mounted" || echo "unmounted"
rm -rf "$LAB"
ls -d "$LAB" 2>/dev/null || echo "directory removed"
```

```
unmounted
directory removed
```

The two echoes are checks, not output from `fusermount3` and `rm`: both are
silent on success, so silence is not evidence that they worked.

Nothing outside `/tmp/inode-lab` was created, modified or deleted at any point.

## What this case does not prove

- **It is a lab.** A real incident has history, other findings competing for
  attention, and a user who did not choose to have this problem. Nothing here
  says the first finding in a real report is the one that matters — see the note
  about the two unrelated findings on the host machine above.
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
  still `find`/`du` work, with the limitations described above.
- **It says nothing about whether the application was right to fail.** An
  application that keeps writing tiny files until it exhausts an inode table is
  a bug in the application; the filesystem only reported it.
