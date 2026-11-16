# PROACTIVE RELIABILITY — R9 CONCURRENCY & SHUTDOWN VERIFICATION

**Mode**: STRICT READ-ONLY AUDIT  
**Date**: 2026-11-16  
**Scope**: Task 01B-3B Final Reliability Audit (Concurrency & Shutdown Verification)

---

## A. Real SQLite Migration Concurrency

### 1. Pembacaan Skema Konkruen
- Pada database legacy tanpa kolom `counter_applied`, jika dua proses memulai `ensureProactiveSchema()` secara bersamaan:
  - Kedua proses mengeksekusi `targetDb.pragma("table_info(proactive_dispatches)")`.
  - Operasi PRAGMA adalah shared read lock; kedua proses membaca skema yang sama dan keduanya mendapati `hasCounterApplied === false`.

### 2. Perilaku `ALTER TABLE` Konkruen & Lock Timeout
- Proses pertama yang mengeksekusi `ALTER TABLE` mengambil schema exclusive lock pada SQLite.
- Proses kedua yang mencoba mengeksekusi `ALTER TABLE` tertahan oleh lock tersebut.
- Karena `busy_timeout` diatur sebesar 10.000 ms (`10s`) pada konfigurasi koneksi (`db.pragma("busy_timeout = 10000")`), driver `better-sqlite3` melakukan polling internal dan tidak langsung gagal dengan `SQLITE_BUSY`.
- Begitu proses pertama selesai dan lock dilepas, proses kedua melanjutkan eksekusi `ALTER TABLE`.
- SQLite menolak penambahan kolom kedua karena nama kolom sudah ada di berkas database fisik, dan melempar:
  ```text
  SqliteError: duplicate column name: counter_applied (code: SQLITE_ERROR)
  ```

### 3. Penanganan Duplicate-Column Spesifik
- Blok `catch (err)` memeriksa tiga syarat kumulatif:
  1. `isSqliteError`: `err.name === "SqliteError" || err.code === "SQLITE_ERROR"`.
  2. `isDuplicateColMsg`: `/^duplicate column name:\s*counter_applied$/i.test(err.message.trim())`.
  3. `nowHasCol`: `targetDb.pragma("table_info(...)").some(c => c.name === "counter_applied")`.
- Jika ketiga syarat terpenuhi, error duplicate column ditolerir sebagai race condition startup.
- Jika kolom belum ada atau error bukan duplicate column `counter_applied`, error dilempar kembali (`throw err`).

### 4. Konfigurasi `busy_timeout`
- Terkonfigurasi pada:
  - `src/storage/sqliteStorage.js`: `new Database(dbPath, { timeout: 10000 })` + `db.pragma("busy_timeout = 10000")`.
  - `test/helpers/multiProcessWorker.js`: `new Database(dbPath, { timeout: 10000 })` + `db.pragma("busy_timeout = 10000")`.
  - `test/proactiveOutbox.test.js`: instance independen dikonfigurasi dengan `{ timeout: 10000 }` dan `busy_timeout = 10000`.

### 5. Penerusan Error Non-Duplicate
- Error disk full (`SQLITE_FULL`), IO error (`SQLITE_IOERR`), korupsi skema (`SQLITE_CORRUPT`), atau duplicate column selain `counter_applied` tidak cocok dengan regex dan langsung dilempar kembali (`throw err`).

### 6. Audit Pengujian R8 & Rancangan Real OS Migration Test
- **Fakta Audit**: Test R8 `migration: concurrent startup simulated race condition tolerates duplicate column if column is present` menggunakan **mock object** (`simulatedDb`), bukan dua proses OS fisik yang bertubrukan pada berkas SQLite riil.
- **Rancangan Test Real OS Multi-process Migration**:
  ```javascript
  // Rancangan untuk verifikasi OS-level migration di masa mendatang:
  // 1. Buat database fisik tanpa kolom counter_applied.
  // 2. Spawn 2 child process Node.js secara paralel (fork).
  // 3. Masing-masing child membuka new Database(path, { timeout: 10000 }) dan memanggil ensureProactiveSchema().
  // 4. Verifikasi kedua child process keluar dengan exit code 0 dan kolom counter_applied terbuat tepat 1 kali.
  ```

---

## B. Real Multi-Process Counter Concurrency

### 1. Mekanisme Transaksi `BEGIN IMMEDIATE`
- Pada `proactiveOutbox.js`:
  ```javascript
  markAcceptedWithState(dispatch, workerId, now, state) {
    const tx = database.transaction(() => {
      // Step 1: UPDATE status='accepted' WHERE status='sending' AND lease_owner=?
      // Step 2: SELECT unanswered_count FROM proactive_state ...
      // Step 3: SELECT COUNT(*) FROM proactive_dispatches WHERE thought_id=? AND counter_applied=1
      // Step 4: if (!thoughtCounterApplied) UPDATE counter_applied=1 ...
      // Step 5: UPDATE proactive_state SET unanswered_count=...
    });
    return tx();
  }
  ```
- Pada `better-sqlite3`, fungsi `database.transaction(fn)` secara default menginisiasi transaksi `BEGIN IMMEDIATE`.
- Transaksi `BEGIN IMMEDIATE` segera mengunci database untuk penulisan (reserved lock), mencegah koneksi lain memulai transaksi tulis di saat bersamaan.

### 2. Atomisitas Pemeriksaan dan Kenaikan Counter
- Pengecekan `thoughtCounterApplied`, penandaan `counter_applied = 1`, dan kenaikan `unanswered_count` berada di dalam **satu transaksi atomik tunggal** (`tx`).
- Tidak ada jeda atau operasi asinkron di dalam blok transaksi SQLite.

### 3. Conditional Update Guard
- `const applyCounter = !thoughtCounterApplied;`
- Proses pertama yang memperoleh lock mendapati `thoughtCounterApplied === false`, mengeset `counter_applied = 1`, menaikkan `unanswered_count`, dan commit.
- Proses kedua yang mengantre mendapati `thoughtCounterApplied === true`, sehingga `applyCounter === false`. Counter tidak dinaikkan dan `counter_applied` untuk dispatch kedua tetap `0`.

### 4. Perbedaan Tegas Level Konkurensi pada Test R7/R8
- **Two Connections (Satu Event Loop)**:
  - Test `multi-process concurrency: counter increments once and no lost updates across independent connections` dijalankan menggunakan **dua koneksi `better-sqlite3` independen (`conn1`, `conn2`) dalam satu proses Node.js**.
  - Menguji atomisitas lock SQLite antar-koneksi pada berkas database fisik yang sama.
- **Two OS Processes (Multi-Process Riil)**:
  - Test `multi-process concurrency: OS-level child process worker verifies cross-process claim and deduplication` dijalankan menggunakan **dua proses OS terpisah** (`parent process` dan `child_process.fork('multiProcessWorker.js')`).
  - Menguji `claimById` dan `enqueueThoughtIfAbsent`.
  - Operasi `markAcceptedWithState` antar dua child process terpisah secara paralel belum diuji pada test runner R7/R8 (hanya teruji pada level two-connection).

---

## C. Shutdown Promise Tracking

### 1. Analisis Skenario Unawaited Dispatch
Skenario yang diperiksa:
> Cycle sudah berjalan -> `drain()` dipanggil -> snapshot promise dibuat sebelum `dispatchPromise` ada -> cycle membuat dispatch baru -> cycle selesai sementara dispatch masih berjalan -> `drain()` selesai sebelum dispatch?

**Hasil Analisis**: Skenario ini **TIDAK MUNGKIN TERJADI** pada implementasi saat ini.

### 2. Bukti Source Code Call Chain
1. Di dalam `runProactiveCycle()` (`proactiveThoughtService.js`):
   ```javascript
   // Baris 520
   this.lastChannelDispatches = await this.dispatchToPlatforms(thoughtText, platform || this.targetPlatform, dispatches) || {};
   ```
2. Di dalam `dispatchToPlatforms()`:
   ```javascript
   // Baris 757
   if (queuedDispatches) return this.processDispatches(queuedDispatches, { recheckPolicy: false });
   ```
3. Di dalam `processDispatches()`:
   ```javascript
   // Baris 604
   this.dispatchPromise = this.runDispatchWorker(initialDispatches, { recheckPolicy });
   try {
     return await this.dispatchPromise;
   } finally {
     this.dispatchPromise = null;
   }
   ```
4. Di dalam `triggerSpontaneousThought()`:
   ```javascript
   // Baris 470
   this.cyclePromise = this.runProactiveCycle({ force, aiProvider, platform });
   try {
     return await this.cyclePromise;
   } finally {
     this.cyclePromise = null;
   }
   ```
5. Di dalam `drain()`:
   ```javascript
   // Baris 854
   async drain() {
     this.stopScheduler();
     await Promise.allSettled([
       this.schedulerTaskPromise,
       this.cyclePromise,
       this.dispatchPromise,
     ].filter(Boolean));
   }
   ```

### 3. Penjelasan Rantai Eksekusi
- `this.cyclePromise` **secara eksplisit melakukan `await` terhadap `dispatchToPlatforms`**, yang melakukan `await` terhadap `processDispatches`, yang melakukan `await` terhadap `this.dispatchPromise`.
- `this.cyclePromise` **tidak akan pernah resolve** sampai seluruh dispatch transport selesai dieksekusi dan hasil status ditulis ke database SQLite.
- Jika `drain()` mengambil snapshot ketika `dispatchPromise` belum ada (`null`), `this.cyclePromise` **sudah ada dalam snapshot**.
- Karena `this.cyclePromise` baru resolve setelah dispatch selesai, `await Promise.allSettled` pada `drain()` terjamin menahan proses shutdown sampai dispatch tuntas.
- Ditambah lagi guard di dalam `runProactiveCycle`:
  ```javascript
  if (this.isShuttingDown) return { triggered: false, reason: "Service shutting down" };
  ```
  Jika shutdown terjadi saat AI sedang menghasilkan teks (sebelum dispatch dibuat), cycle langsung berhenti tanpa membuat dispatch baru.

### 4. Penutupan Database
- Di `server.js`:
  ```javascript
  reminderService.stopScheduler();
  proactiveThoughtService.stopScheduler();
  await proactiveThoughtService.drain();
  ...
  closeDatabase();
  ```
- `closeDatabase()` dipanggil setelah `drain()` selesai sepenuhnya. Database tidak pernah ditutup saat cycle atau dispatch sedang berjalan.

---

## D. Verification Matrix

| Klaim | Bukti Source | Bukti Test | Status |
| :--- | :--- | :--- | :--- |
| **Migration multi-process** | `ensureProactiveSchema()` di `proactiveOutbox.js`: cek skema via pragma, lock schema SQLite, tangkap duplicate-column spesifik `counter_applied` dan validasi ulang kolom. | Test unit/mock `migration: concurrent startup simulated race condition tolerates duplicate column...` di `proactiveOutbox.test.js`. | **PARTIALLY VERIFIED** (Logika toleransi duplicate column terbukti valid, tetapi pengujian balapan riil menggunakan mock, belum 2 child process OS simultan). |
| **Counter atomicity** | `markAcceptedWithState()` di `proactiveOutbox.js`: transaksi `BEGIN IMMEDIATE` memadukan cek `counter_applied=1`, update status, dan update counter. | Test `multi-process concurrency: counter increments once and no lost updates across independent connections` di `proactiveOutbox.test.js`. | **VERIFIED** (Terbukti atomik pada 2 koneksi independen pada berkas database fisik sama). |
| **OS-level claim concurrency** | `claimById()` dengan conditional UPDATE `status='sending'` dan lease worker di `proactiveOutbox.js`. | Test `multi-process concurrency: OS-level child process worker verifies cross-process claim and deduplication` via `child_process.fork()` di `proactiveOutbox.test.js`. | **VERIFIED** (Terbukti antar dua proses OS terpisah). |
| **Shutdown waits cycle** | `stopScheduler()` pasang `isShuttingDown=true`; `drain()` awaits `this.cyclePromise` via `Promise.allSettled`. | Test `shutdown lifecycle: shutdown during in-flight cycle settles cleanly and prevents new cycles` di `proactiveOutbox.test.js`. | **VERIFIED** |
| **Shutdown waits dispatch created by cycle** | `runProactiveCycle()` melakukan `await this.dispatchToPlatforms()`, `cyclePromise` tidak resolve sebelum dispatch selesai. | Test `shutdown lifecycle: shutdown during in-flight transport completes in-flight and stops further claims` di `proactiveOutbox.test.js`. | **VERIFIED** |
| **No new work after shutdown** | Guard `if (this.isShuttingDown)` di `triggerSpontaneousThought()`, `runProactiveCycle()`, dan `processDispatches()`. | Test `shutdown lifecycle: manual trigger blocked after shutdown initiated` di `proactiveOutbox.test.js`. | **VERIFIED** |
| **DB closes after all work** | `server.js` memanggil `await proactiveThoughtService.drain()` sebelum mengeksekusi `closeDatabase()`. | Test `shutdown lifecycle: database not closed before active async work completes` di `proactiveOutbox.test.js`. | **VERIFIED** |

---

## E. Kesimpulan Akhir R9

1. **Kekuatan Utama**:
   - Rantai shutdown promise (`cyclePromise -> dispatchPromise -> drain() -> closeDatabase()`) terbukti solid, tertutup rapat, dan bebas dari unawaited async leakage.
   - Atomisitas counter dan claim terlindungi transaksi `BEGIN IMMEDIATE` dan conditional update SQLite.
2. **Keterbatasan yang Diakui Secara Terbuka**:
   - Pengujian balapan migrasi (`ensureProactiveSchema`) pada R7/R8 menggunakan simulated mock object, bukan dua proses OS riil.
   - Pengujian konkurensi counter antar dua worker menggunakan dua koneksi terpisah dalam satu proses Node.js, bukan dua proses OS terpisah (meskipun pengujian klaim dispatch sudah menggunakan dua proses OS riil).

Dokumen ini disimpan sebagai catatan verifikasi resmi R9. Tidak ada modifikasi kode pada sesi ini. Task 02 belum dimulai.
