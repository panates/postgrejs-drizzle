# Changelog

<!-- rman:documented-up-to 224891434952e9fa8e131e5e933c9fb44eb1d907 -->

## v1.1.1 (2026-10-06)

### 🧹 Chores

- sync lockfile (b57ebcc)
- raise the dev dependencies, and drop `.ncurc.yml` (23af37a)

### 💬 General Changes

- turn off `asyncErrorHandling`, which `pg` has no counterpart for (016bd5f)

---

## v1.1.0 (2026-09-29)

### ✨ Features

- choose the protocol before sending, not after being refused (ef1383f)

### 🐛 Bug Fixes

- measure memory in a process of its own, and count what is off the heap (250cf11)
- separate what a driver holds from what a call throws away (58276b3)
- **bench:** let the int4[] values be a dimension, not a choice (f6c0cf5)

### 📚 Documentation

- name 3.11.0, which is what the floor and the verification are now (38e7f30)
- drop the Status section (c807344)
- re-measure on postgrejs 3.11.0 (5f4b216)
- say where this benchmark and postgrejs's own differ (2c1cf5f)
- the accounting difference is closed (4ee3a7a)
- say why memory gets a process each and the timings do not (edb20ab)

### 📦 Build System

- generate the benchmark report instead of copying it across (f0aa0db)
- move to rman, github-actions@v3 and the shared preset (440a5ba)
- run `rman build` in the drizzle suite script, because `npm run build` is gone (189b4c2)

### 💬 General Changes

- three bytea sizes, so the payload advantage has a shape (462f099)
- drop the numeric scenarios (8b465e0)
- read every scenario's data from a table, and let the report say pg won (011a38c)
- re-measure on the uuid decode fix, which turns that row over (7170951)
- fold peak memory into each driver's cell (0431429)
- show the memory difference as a percentage, not a multiple (7ca37f2)
- disclose that pg and postgrejs are not always on the same protocol (0a0660c)
- bind a parameter everywhere, so both drivers speak the extended protocol (1d2b4a8)
- one size per type, grouped into reading and writing, with writes (2a46195)
- count what goes out, widen the write values, and say who wins each write (6292ad1)
- re-measure on the array-literal fix, which turns that write over (62101ae)
- make peak memory what one call needs, not what a batch leaves behind (d06aae3)
- say what the peak is, and report what each client keeps (7ee0aaa)
- the large writes hold a buffer, and it comes back (66219c8)
- say what the driver actually sends: text, not binary (c13b7dc)
- measure what a run needs, not just what a call adds (8a0a92e)
- move to postgrejs 3.12.0 and re-measure on it (b6ac46c)
- count the garbage, and say where counting it stops working (58b0ff2)
- say that the high-water is partly about the process around us (f57acfe)
- read the peak at the end of the call instead of hoping to sample it (ec40cb2)
- measure what a call allocates, because a per-call peak cannot be (8687195)
- say that the memory number is a rate, and what one call is (a085bb0)
- hold the same 5000 float8s in two shapes, and say each scenario's shape (a3b0e92)
- cut the method and reading sections, and group their rows by memory (5d97a36)
- re-run on postgrejs 3.12.1, which carries both fixes reported from here (6bd2b9b)
- the peer range resolves to 3.12.1 now, and both suites were re-run on it (2e9736e)

---

## v1.0.4 (2026-09-23)

### 📚 Documentation

- update contributors list in package.json (fdd50be)

---

## v1.0.3 (2026-09-23)

### 📚 Documentation

- put the README in the order a reader decides in (2140c47)
- drop the umbrella over the four speed sections (31d9c95)
- let the mechanism read as prose (be0e4e8)
- take the README's shape from postgrejs-prisma's current one (8e9e6ba)
- add the badge block (8b5ef99)

### 🧹 Chores

- bump postgrejs to 3.11.0 and prettier to 3.9.9 (bb499d5)

---

## v1.0.2 (2026-09-22)

### 📚 Documentation

- say what the defaults buy you, not what they defend against (04314c4)
- lead with what the client underneath is worth (7f09452)

---

## v1.0.1 (2026-09-22)

### 📚 Documentation

- a gap in PostgreJS is reported here, not worked around (4edc3cc)

### 🧹 Chores

- move the floor to postgrejs 3.10.1 and drizzle-orm 0.45.3 (91928b1)

---

## v0.1.0 (2026-09-20)

### ✨ Features

- a Drizzle ORM driver for PostgreJS (ff9990e)

### 💬 General Changes

- Initial commit (89fc170)
