package app.hiperverso;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.OpenableColumns;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Ponte nativa para receber compartilhamentos do sistema Android (ACTION_SEND / ACTION_SEND_MULTIPLE).
 * Copia os arquivos para o cache interno enquanto a permissão temporária da URI da Intent está ativa.
 */
@CapacitorPlugin(name = "ShareBridge")
public class ShareBridgePlugin extends Plugin {

  private static final int MAX_SHARED_FILES = 4;
  private static final long MAX_FILE_BYTES = 50L * 1024L * 1024L;
  private static final long STALE_CACHE_MS = 60L * 60L * 1000L;

  private static final AtomicReference<ShareBridgePlugin> ACTIVE_INSTANCE = new AtomicReference<>();
  private static final AtomicReference<PendingShare> PENDING_SHARE = new AtomicReference<>();
  private static final Map<String, StagedFile> STAGED_FILES = new ConcurrentHashMap<>();

  private static final class StagedFile {
    final String id;
    final String name;
    final String mimeType;
    final long size;
    final File cacheFile;

    StagedFile(String id, String name, String mimeType, long size, File cacheFile) {
      this.id = id;
      this.name = name;
      this.mimeType = mimeType;
      this.size = size;
      this.cacheFile = cacheFile;
    }

    JSObject toJS() {
      JSObject obj = new JSObject();
      obj.put("id", id);
      obj.put("name", name);
      obj.put("mimeType", mimeType);
      obj.put("size", size);
      return obj;
    }
  }

  private static final class PendingShare {
    final String title;
    final String text;
    final List<StagedFile> files;

    PendingShare(String title, String text, List<StagedFile> files) {
      this.title = title;
      this.text = text;
      this.files = files;
    }

    JSObject toJS() {
      JSObject obj = new JSObject();
      obj.put("hasShare", true);
      obj.put("title", title);
      obj.put("text", text);
      JSArray arr = new JSArray();
      for (StagedFile f : files) {
        arr.put(f.toJS());
      }
      obj.put("files", arr);
      return obj;
    }
  }

  @Override
  public void load() {
    super.load();
    ACTIVE_INSTANCE.set(this);
  }

  public static void stageIntent(Context context, Intent intent) {
    if (context == null || intent == null) return;
    String action = intent.getAction();
    if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) {
      return;
    }

    pruneOldCacheFiles(context);

    String subject = safeTrim(intent.getStringExtra(Intent.EXTRA_SUBJECT));
    if (subject.isEmpty()) {
      subject = safeTrim(intent.getStringExtra(Intent.EXTRA_TITLE));
    }
    String text = safeTrim(intent.getStringExtra(Intent.EXTRA_TEXT));

    List<Uri> uris = new ArrayList<>();
    if (Intent.ACTION_SEND.equals(action)) {
      Uri single = getParcelableUri(intent, Intent.EXTRA_STREAM);
      if (single != null) uris.add(single);
    } else {
      ArrayList<Uri> multi = getParcelableUriList(intent, Intent.EXTRA_STREAM);
      if (multi != null) uris.addAll(multi);
    }

    List<StagedFile> staged = new ArrayList<>();
    for (Uri uri : uris) {
      if (staged.size() >= MAX_SHARED_FILES) break;
      StagedFile item = copyUriToCache(context, uri, intent.getType());
      if (item != null) {
        staged.add(item);
        STAGED_FILES.put(item.id, item);
      }
    }

    if (subject.isEmpty() && text.isEmpty() && staged.isEmpty()) {
      return;
    }

    PendingShare pending = new PendingShare(subject, text, staged);
    PENDING_SHARE.set(pending);

    ShareBridgePlugin instance = ACTIVE_INSTANCE.get();
    if (instance != null && instance.hasListeners("shareReceived")) {
      JSObject eventData = new JSObject();
      eventData.put("hasShare", true);
      instance.notifyListeners("shareReceived", eventData);
    }
  }

  @PluginMethod
  public void consumePendingShare(PluginCall call) {
    PendingShare pending = PENDING_SHARE.getAndSet(null);
    if (pending == null) {
      JSObject empty = new JSObject();
      empty.put("hasShare", false);
      call.resolve(empty);
      return;
    }
    call.resolve(pending.toJS());
  }

  @PluginMethod
  public void readSharedFile(PluginCall call) {
    String id = call.getString("id", "");
    if (id == null || id.isEmpty()) {
      call.reject("Identificador de arquivo inválido.");
      return;
    }
    StagedFile staged = STAGED_FILES.remove(id);
    if (staged == null || !staged.cacheFile.exists()) {
      call.reject("Arquivo compartilhado expirado ou indisponível.");
      return;
    }
    getBridge().execute(() -> {
      try (FileInputStream in = new FileInputStream(staged.cacheFile);
           ByteArrayOutputStream out = new ByteArrayOutputStream()) {
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) {
          out.write(buf, 0, n);
        }
        String base64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        JSObject ret = new JSObject();
        ret.put("id", staged.id);
        ret.put("name", staged.name);
        ret.put("mimeType", staged.mimeType);
        ret.put("size", staged.size);
        ret.put("base64", base64);
        call.resolve(ret);
      } catch (Exception e) {
        call.reject("Falha ao ler arquivo compartilhado.", e);
      } finally {
        // Remove arquivo temporário logo após leitura para não acumular espaço no aparelho
        // noinspection ResultOfMethodCallIgnored
        staged.cacheFile.delete();
      }
    });
  }

  @PluginMethod
  public void clearSharedFiles(PluginCall call) {
    PENDING_SHARE.set(null);
    for (StagedFile item : STAGED_FILES.values()) {
      if (item.cacheFile != null && item.cacheFile.exists()) {
        // noinspection ResultOfMethodCallIgnored
        item.cacheFile.delete();
      }
    }
    STAGED_FILES.clear();
    call.resolve();
  }

  private static String safeTrim(String val) {
    return val == null ? "" : val.trim();
  }

  @SuppressWarnings("deprecation")
  private static Uri getParcelableUri(Intent intent, String key) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return intent.getParcelableExtra(key, Uri.class);
    }
    return intent.getParcelableExtra(key);
  }

  @SuppressWarnings("deprecation")
  private static ArrayList<Uri> getParcelableUriList(Intent intent, String key) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      return intent.getParcelableArrayListExtra(key, Uri.class);
    }
    return intent.getParcelableArrayListExtra(key);
  }

  private static StagedFile copyUriToCache(Context context, Uri uri, String fallbackMime) {
    if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) return null;
    try {
      ContentResolver resolver = context.getContentResolver();
      String mime = resolver.getType(uri);
      if (mime == null || mime.isEmpty()) {
        mime = fallbackMime != null && !fallbackMime.isEmpty() ? fallbackMime : "application/octet-stream";
      }
      String displayName = queryDisplayName(resolver, uri, mime);
      String id = UUID.randomUUID().toString();
      File dir = new File(context.getCacheDir(), "incoming_share");
      if (!dir.exists() && !dir.mkdirs()) return null;
      File dest = new File(dir, id + "_" + sanitizeFilename(displayName));

      long total = 0;
      try (InputStream in = resolver.openInputStream(uri);
           FileOutputStream out = new FileOutputStream(dest)) {
        if (in == null) return null;
        byte[] buf = new byte[16384];
        int len;
        while ((len = in.read(buf)) != -1) {
          total += len;
          if (total > MAX_FILE_BYTES) {
            // noinspection ResultOfMethodCallIgnored
            dest.delete();
            return null;
          }
          out.write(buf, 0, len);
        }
      }
      if (total <= 0) {
        // noinspection ResultOfMethodCallIgnored
        dest.delete();
        return null;
      }
      return new StagedFile(id, displayName, mime, total, dest);
    } catch (Exception ignored) {
      return null;
    }
  }

  private static String queryDisplayName(ContentResolver resolver, Uri uri, String mime) {
    try (Cursor cursor = resolver.query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
      if (cursor != null && cursor.moveToFirst()) {
        int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
        if (idx >= 0) {
          String name = cursor.getString(idx);
          if (name != null && !name.trim().isEmpty()) return name.trim();
        }
      }
    } catch (Exception ignored) {
      // fallback below
    }
    String ext = mime.startsWith("video/") ? "mp4"
        : mime.equals("image/png") ? "png"
        : mime.equals("image/webp") ? "webp"
        : mime.equals("image/gif") ? "gif"
        : mime.equals("application/pdf") ? "pdf"
        : "jpg";
    return "compartilhado." + ext;
  }

  private static String sanitizeFilename(String raw) {
    String clean = raw.replaceAll("[^a-zA-Z0-9._-]", "_");
    return clean.length() > 80 ? clean.substring(clean.length() - 80) : clean;
  }

  private static void pruneOldCacheFiles(Context context) {
    try {
      File dir = new File(context.getCacheDir(), "incoming_share");
      File[] files = dir.listFiles();
      if (files == null) return;
      long cutoff = System.currentTimeMillis() - STALE_CACHE_MS;
      for (File f : files) {
        if (f.lastModified() < cutoff) {
          // noinspection ResultOfMethodCallIgnored
          f.delete();
        }
      }
    } catch (Exception ignored) {
      // ignore
    }
  }
}

