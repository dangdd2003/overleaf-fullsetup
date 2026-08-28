package uk.ac.ic.wlgitbridge.server;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import org.slf4j.LoggerFactory;

public class GceMetadataLogLevelChecker {

  private static final Path TRACING_END_TIME_FILE = Path.of("/logging/tracingEndTime");

  private final Logger appLogger;
  private final Level defaultLevel;
  private final ScheduledExecutorService scheduler;

  /**
   * @param serviceName retained for constructor backwards compatibility
   * @param defaultLevel default logback log level
   */
  public GceMetadataLogLevelChecker(String serviceName, Level defaultLevel) {
    this.appLogger = (Logger) LoggerFactory.getLogger("uk.ac.ic.wlgitbridge");
    this.defaultLevel = defaultLevel;
    this.scheduler =
        Executors.newSingleThreadScheduledExecutor(
            r -> {
              Thread t = new Thread(r, "log-level-checker");
              t.setDaemon(true);
              return t;
            });
  }

  public void start() {
    checkLogLevel();
    scheduler.scheduleAtFixedRate(this::checkLogLevel, 60, 60, TimeUnit.SECONDS);
  }

  public void stop() {
    scheduler.shutdown();
  }

  private void checkLogLevel() {
    try {
      long endTime = fetchTracingEndTime();
      if (endTime > System.currentTimeMillis()) {
        setLevel(Level.TRACE);
      } else {
        setLevel(defaultLevel);
      }
    } catch (Exception e) {
      setLevel(defaultLevel);
    }
  }

  private void setLevel(Level newLevel) {
    Level currentLevel = appLogger.getLevel();
    if (currentLevel == newLevel) return;
    appLogger.setLevel(newLevel);
    appLogger.info("Log level changed from {} to {}", currentLevel, newLevel);
  }

  private long fetchTracingEndTime() {
    try {
      if (Files.exists(TRACING_END_TIME_FILE)) {
        return Long.parseLong(Files.readString(TRACING_END_TIME_FILE).trim());
      }
    } catch (Exception ignored) {
      // File not present or invalid
    }
    return 0;
  }
}

