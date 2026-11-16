import app from "./app.js";
import { config } from "./config/env.js";
import { memoryService } from "./services/memory/memoryService.js";
import { reminderService } from "./services/reminder/reminderService.js";
import { vtubeService } from "./services/vtube/vtubeService.js";
import { proactiveThoughtService } from "./services/ai/proactiveThoughtService.js";
import { closeDatabase } from "./storage/sqliteStorage.js";
import { logger } from "./utils/logger.js";
import { waitForActiveHandlers, getActiveHandlersCount } from "./utils/httpHandlerTracker.js";

/**
 * Initialise all backend services and start the Express server.
 * Returns the underlying http.Server instance for further handling
 * (e.g., graceful shutdown).
 * @returns {import('http').Server}
 */

export const startServer = () => {
  logger.info("Initializing Lucy AI Backend Services...");
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";

  // Initialize Memory
  memoryService.initialize();

  if (!isTest) {
    // Start background schedulers only in runtime mode.
    reminderService.startScheduler();
    proactiveThoughtService.startScheduler();
    vtubeService.initialize();
  }

  // Auto-start bots if enabled and tokens exist
  if (!isTest && config.autoStartBots) {
    if (config.discordBotToken) {
      import("./bots/discordBot.js")
        .then(({ startDiscordBot }) => {
          logger.info("Auto-starting Discord bot...");
          return startDiscordBot();
        })
        .catch((err) => logger.warn(`Failed to auto-start Discord bot: ${err.message}`));
    }
    if (config.telegramBotToken) {
      import("./bots/telegramBot.js")
        .then(({ startTelegramBot }) => {
          logger.info("Auto-starting Telegram bot...");
          return startTelegramBot();
        })
        .catch((err) => logger.warn(`Failed to auto-start Telegram bot: ${err.message}`));
    }
  }

  const server = app.listen(config.port, () => {
    logger.info(`=========================================`);
    logger.info(`🤖 Lucy AI Backend Server running on port ${config.port}`);
    logger.info(`🧠 Active AI Provider: ${config.aiProvider}`);
    logger.info(`🕒 System Time (WIB): ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })}`);
    logger.info(`📡 Health Check: http://localhost:${config.port}/api/health`);
    logger.info(`=========================================`);
  });

  return server;
};

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

export const setupGracefulShutdown = (server, {
  exitProcess = true,
  socketTimeoutMs = 10000,
  handlerTimeoutMs = 30000,
  timeoutMs = null, // backward compatibility
  waitForHandlers = waitForActiveHandlers,
} = {}) => {
  const actualSocketTimeoutMs = timeoutMs ?? socketTimeoutMs;
  let shutdownPromise = null;
  const shutdown = async () => {
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      logger.info("Shutting down Lucy AI Backend Server...");

      // 1. Stop accepting new HTTP requests and force-close stalled sockets after timeout
      try {
        await closeHttpServer(server, actualSocketTimeoutMs);
      } catch (err) {
        logger.warn(`Error closing HTTP server: ${err.message}`);
      }

      // 2. Wait for all tracked asynchronous controller handlers to settle
      let allHandlersSettled = false;
      try {
        allHandlersSettled = await waitForHandlers(handlerTimeoutMs);
        if (!allHandlersSettled) {
          logger.error(`Shutdown warning: ${getActiveHandlersCount()} HTTP handler(s) did not settle within ${handlerTimeoutMs}ms.`);
        }
      } catch (err) {
        let errorMessage;
        try {
          errorMessage = err instanceof Error ? err.message : String(err);
        } catch {
          errorMessage = "Unknown thrown value";
        }
        logger.error(`Error waiting for HTTP handlers: ${errorMessage}`);
      }

      // 3. Stop reminder scheduler
      try {
        reminderService.stopScheduler();
      } catch (err) {
        logger.warn(`Error stopping reminder scheduler: ${err.message}`);
      }

      // 4 & 5. Stop proactive scheduler and wait for active cycle/dispatch to finish
      try {
        proactiveThoughtService.stopScheduler();
        await proactiveThoughtService.drain();
      } catch (err) {
        logger.error(`Error draining proactive service: ${err.message}`);
      }

      // 6. Disconnect VTube Studio
      try {
        vtubeService.disconnect();
      } catch {
        // Ignored
      }

      // 7. Stop Discord bot
      try {
        const { stopDiscordBot } = await import("./bots/discordBot.js");
        await stopDiscordBot();
      } catch {
        // Ignored if bot not active
      }

      // 8. Stop Telegram bot
      try {
        const { stopTelegramBot } = await import("./bots/telegramBot.js");
        await stopTelegramBot();
      } catch {
        // Ignored if bot not active
      }

      // 9. Close SQLite connection ONLY if all handlers and background services have stopped
      if (allHandlersSettled && getActiveHandlersCount() === 0) {
        try {
          closeDatabase();
        } catch {
          // Ignored
        }
      } else {
        logger.warn("SQLite connection kept open because active HTTP handler(s) are still executing.");
      }

      logger.info("Server closed cleanly. Graceful shutdown finished.");
      if (exitProcess) {
        process.exit(allHandlersSettled ? 0 : 1);
      }
    })();

    return shutdownPromise;
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
    shutdown();
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    shutdown();
  });

  return shutdown;
};

// Run server only when executed directly
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMain) {
  const server = startServer();
  setupGracefulShutdown(server);
}

export default app;
