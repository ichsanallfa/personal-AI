# PROACTIVE RELIABILITY — R12 SHUTDOWN TIMEOUT AUDIT

**Date**: 2026-11-16  
**Scope**: Task 01B-3B Shutdown Timeout Audit (`closeHttpServer` & Async Handler Lifecycle)  
**Mode**: STRICT READ-ONLY AUDIT (No modifications to production source code)

---

## 1. Analisis Skenario `closeHttpServer()` (Bagian A)

Implementasi saat ini pada `backend/src/server.js`:
```javascript
const closeHttpServer = (httpServer, timeoutMs = 10000) => new Promise((resolve) => {
  if (!httpServer || typeof httpServer.close !== "function" || !httpServer.listening) {
    return resolve();
  }

  let closed = false;
  const timer = setTimeout(() => {
    if (!closed) {
      closed = true;
      if (typeof httpServer.closeAllConnections === "function") {
        httpServer.closeAllConnections();
      }
      resolve();
    }
  }, timeoutMs);
  timer.unref?.();

  if (typeof httpServer.closeIdleConnections === "function") {
    httpServer.closeIdleConnections();
  }

  httpServer.close(() => {
    if (!closed) {
      closed = true;
      clearTimeout(timer);
      resolve();
    }
  });
});
```

### Evaluasi terhadap Skenario Audit:
1. **HTTP request masuk dan menjalankan operasi asynchronous lebih lama dari `timeoutMs`**:
   - Handler Express (misal `POST /api/chat`) mulai berjalan dan masuk ke operasi asynchronous (misal panggilan AI, I/O eksternal, atau timer).
2. **Timeout memanggil `server.closeAllConnections()`**:
   - Setelah `timeoutMs` (10.000 ms), timer terpicu dan memanggil `httpServer.closeAllConnections()`.
   - Soket TCP/HTTP antara client dan server diputus secara paksa oleh Node.js network stack.
   - `closeHttpServer()` langsung melakukan `resolve()`.
3. **Apakah handler/controller tetap dapat berjalan setelah koneksi HTTP diputus?**:
   - **YA**. Pemutusan soket TCP di level transport **tidak menghentikan** eksekusi JavaScript Promise di call stack / microtask queue V8.
   - Fungsi asynchronous di dalam handler controller tetap hidup dan terus dieksekusi hingga tuntas atau melempar error.
4. **Apakah promise handler masih dapat mengakses SQLite?**:
   - **YA**. Ketika operasi async (misal LLM response) selesai, baris kode berikutnya di controller (misal `memoryService.addMemory(...)` atau `writeDocument(...)`) tetap dieksekusi.
5. **Apakah callback `server.close()` dapat selesai sementara pekerjaan asynchronous di handler belum selesai?**:
   - **YA**. Karena soket fisik sudah diputus oleh `closeAllConnections()`, `http.Server` mendeteksi bahwa tidak ada lagi koneksi yang tersisa, sehingga event `close` pada HTTP server terpicu dan callback `server.close()` selesai, meskipun promise handler controller masih melayang di event loop.
6. **Apakah `closeDatabase()` tetap bisa dijalankan ketika handler tersebut masih aktif?**:
   - **YA**. Karena `closeHttpServer()` telah resolve, urutan shutdown di `setupGracefulShutdown` berlanjut ke langkah penutupan database (`closeDatabase()`).
   - Ketika handler yang tertinggal akhirnya mencoba menulis ke database, `db.open` sudah bernilai `false`, memicu `SqliteError: The database connection is not open` atau unhandled rejection.

---

## 2. Bukti Pengujian Terpisah (Bagian B)

Test verifikasi dibuat di `personal-ai-chatbot/backend/test/r12ShutdownTimeoutAudit.test.js`:
- Endpoint `/long-operation` disimulasikan memiliki proses async berdurasi **200 ms**.
- Shutdown dijalankan dengan batas timeout dipercepat menjadi **50 ms**.
- Handler mencoba melakukan `INSERT` ke database SQLite fisik sementara setelah penundaan 200 ms.

### Hasil Eksekusi Test:
Perintah:
`node --import ./test/setup.js --test test/r12ShutdownTimeoutAudit.test.js`

Output:
```text
✔ R12 Audit: closing HTTP sockets via timeout does NOT wait for unhandled async handler promises (331.4ms)
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

### Fakta yang Terbukti Secara Empiris:
1. `handlerStarted === true`: Handler controller telah menerima request dan mulai berjalan.
2. `shutdownDuration < 150ms`: `closeHttpServer()` resolve pada ~50 ms karena timeout memutus soket fisik.
3. `testDb.open === false`: Database ditutup oleh siklus shutdown pada ~50 ms.
4. `dbOpenWhenHandlerAccessed === false`: Handler bangun pada 200 ms dan mendapati koneksi database sudah tertutup.
5. `errorCaughtInHandler`: Melempar error `SqliteError: The database connection is not open`.
6. `handlerFinished === false`: Operasi penulisan database gagal tersimpan.

---

## 3. Rekomendasi Solusi Minimum (Bagian C)

Untuk mengatasi risiko pemutusan database sebelum handler async selesai tanpa menambah kompleksitas berlebih:

### Solusi 1: In-Flight Request / Handler Tracking Middleware
Tambahkan middleware penghitung request aktif pada Express (`app.js`):
```javascript
let activeRequestCount = 0;
const idleWaiters = new Set();

app.use((req, res, next) => {
  activeRequestCount++;
  const onEnd = () => {
    res.removeListener("finish", onEnd);
    res.removeListener("close", onEnd);
    activeRequestCount--;
    if (activeRequestCount === 0) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
  };
  res.on("finish", onEnd);
  res.on("close", onEnd);
  next();
});

export const waitForHttpHandlersToComplete = (timeoutMs = 10000) => new Promise((resolve) => {
  if (activeRequestCount === 0) return resolve();
  const timer = setTimeout(() => {
    idleWaiters.delete(resolve);
    resolve();
  }, timeoutMs);
  timer.unref?.();
  idleWaiters.add(() => {
    clearTimeout(timer);
    resolve();
  });
});
```

### Solusi 2: Penyesuaian Urutan di `setupGracefulShutdown()`
Panggil `await waitForHttpHandlersToComplete(timeoutMs)` sebelum memanggil `closeDatabase()`:
```javascript
// 1. Stop terima koneksi baru
await closeHttpServer(server, timeoutMs);
// 2. Tunggu handler yang sedang jalan selesai total
await waitForHttpHandlersToComplete(timeoutMs);
// 3. Drain schedulers & bots
reminderService.stopScheduler();
proactiveThoughtService.stopScheduler();
await proactiveThoughtService.drain();
...
// 4. Terakhir, tutup database
closeDatabase();
```

### Solusi 3: Pemeriksaan Status Koneksi Sebelum Penulisan Database di Controller
Pada controller/service yang melakukan penulisan database pasca-I/O panjang:
- Periksa `if (req.destroyed) return;` atau `if (!db.open) return;` sebelum mengeksekusi query lanjutan.

---

## 4. Kesimpulan Status R12

| Aspek Audit | Status | Keterangan |
| :--- | :--- | :--- |
| **A. Pemisahan Status Soket vs Handler Async** | **VERIFIED (Celah Ada)** | Terbukti bahwa memutus soket via `closeAllConnections()` tidak membatalkan promise handler async. Handler tetap hidup di event loop. |
| **B. Potensi Error DB Closed pada Timeout** | **VERIFIED (Celah Ada)** | Terbukti via `test/r12ShutdownTimeoutAudit.test.js`: jika timeout terjadi, database tertutup lebih awal dan handler melempar `SqliteError: The database connection is not open`. |
| **C. Rekomendasi Solusi** | **PROPOSED** | Direkomendasikan active request counter middleware sederhana tanpa over-engineering. |

**STOP**: Source code produksi belum diubah sesuai aturan strict read-only. Task 02 belum dimulai. Menunggu review dan persetujuan eksplisit.
