package app.hiperverso;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

  // A tela de abertura fica até o site carregar (sem mostrar uma tela vazia enquanto ele baixa), mas nunca mais que
  // isto: sem internet o app abre e o site mostra o erro.
  private static final long ABERTURA_MAXIMA_MS = 4000;
  private volatile boolean siteCarregado = false;

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Antes do super.onCreate: no Android 11 e anteriores é isto que desenha a lula na abertura (sem isto ficava só a
    // cor de fundo); no 12+ a abertura é a do sistema, com o mesmo fundo e ícone do tema AppTheme.NoActionBarLaunch.
    SplashScreen abertura = SplashScreen.installSplashScreen(this);
    registerPlugin(BiometricBridgePlugin.class);
    registerPlugin(ShareBridgePlugin.class);
    ShareBridgePlugin.stageIntent(this, getIntent());
    long inicio = SystemClock.uptimeMillis();
    abertura.setKeepOnScreenCondition(() -> !siteCarregado && SystemClock.uptimeMillis() - inicio < ABERTURA_MAXIMA_MS);
    bridgeBuilder.addWebViewListener(new WebViewListener() {
      @Override
      public void onPageLoaded(WebView webView) {
        siteCarregado = true;
      }

      @Override
      public void onReceivedError(WebView webView) {
        siteCarregado = true;
      }
    });

    super.onCreate(savedInstanceState);
    criarCanaisDeNotificacao();
    reservarEspacoDasBarras();
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    ShareBridgePlugin.stageIntent(this, intent);
  }

  /** Garante canais de notificação organizados já na inicialização do app (Android 8+). */
  private void criarCanaisDeNotificacao() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm == null) return;

    NotificationChannel messages = new NotificationChannel(
        "exelula_messages",
        "Mensagens Diretas e Grupos",
        NotificationManager.IMPORTANCE_HIGH
    );
    messages.setDescription("Novas mensagens diretas e conversas em grupo");
    messages.enableVibration(true);
    messages.enableLights(true);

    NotificationChannel security = new NotificationChannel(
        "exelula_security",
        "Segurança e Login (IDP2P)",
        NotificationManager.IMPORTANCE_HIGH
    );
    security.setDescription("Pedidos de aprovação de novos aparelhos e alertas da conta");
    security.enableVibration(true);
    security.enableLights(true);

    NotificationChannel mentions = new NotificationChannel(
        "exelula_mentions",
        "Menções e Respostas",
        NotificationManager.IMPORTANCE_HIGH
    );
    mentions.setDescription("Quando citam, mencionam ou respondem a você");
    mentions.enableVibration(true);
    mentions.enableLights(true);

    NotificationChannel social = new NotificationChannel(
        "exelula_default",
        "Atividade Social",
        NotificationManager.IMPORTANCE_DEFAULT
    );
    social.setDescription("Curtidas, reposts e novos seguidores");
    social.enableLights(true);

    nm.createNotificationChannel(messages);
    nm.createNotificationChannel(security);
    nm.createNotificationChannel(mentions);
    nm.createNotificationChannel(social);
  }

  /**
   * O Android 15 (targetSdk 35) desenha o app por baixo da barra de status e da barra de navegação ("edge-to-edge") e o
   * Capacitor 6 não compensa: o relógio e os ícones de notificação ficavam por cima do cabeçalho do site, e a barra de
   * gestos por cima da navegação de baixo. O conteúdo recebe o espaço das barras (e do teclado, para o campo digitado
   * não ficar escondido) como margem; atrás delas aparece o fundo da marca, com ícones claros. Igual em todas as versões.
   */
  private void reservarEspacoDasBarras() {
    WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
    WindowInsetsControllerCompat barras = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
    barras.setAppearanceLightStatusBars(false);
    barras.setAppearanceLightNavigationBars(false);
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      getWindow().setNavigationBarContrastEnforced(false); // sem o véu cinza sobre a cor da marca na navegação por botões
    }
    View conteudo = findViewById(android.R.id.content);
    ViewCompat.setOnApplyWindowInsetsListener(conteudo, (view, insets) -> {
      Insets sistema = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
      Insets teclado = insets.getInsets(WindowInsetsCompat.Type.ime());
      view.setPadding(sistema.left, sistema.top, sistema.right, Math.max(sistema.bottom, teclado.bottom));
      return WindowInsetsCompat.CONSUMED;
    });
  }
}
