package app.hiperverso;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.concurrent.Executor;

@CapacitorPlugin(name = "BiometricBridge")
public class BiometricBridgePlugin extends Plugin {

  private static final int ALLOWED_AUTHENTICATORS =
      BiometricManager.Authenticators.BIOMETRIC_STRONG
          | BiometricManager.Authenticators.BIOMETRIC_WEAK
          | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

  @PluginMethod
  public void isAvailable(PluginCall call) {
    BiometricManager manager = BiometricManager.from(getContext());
    int result = manager.canAuthenticate(ALLOWED_AUTHENTICATORS);
    JSObject ret = new JSObject();
    ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
    ret.put("code", result);
    call.resolve(ret);
  }

  @PluginMethod
  public void authenticate(PluginCall call) {
    BiometricManager manager = BiometricManager.from(getContext());
    if (manager.canAuthenticate(ALLOWED_AUTHENTICATORS) != BiometricManager.BIOMETRIC_SUCCESS) {
      call.reject("Biometria ou bloqueio de tela não configurado neste aparelho.");
      return;
    }

    String title = call.getString("title", "Confirmar identidade · Exe. Lula");
    String subtitle = call.getString("subtitle", "Use sua digital, rosto ou senha do aparelho");

    getActivity().runOnUiThread(() -> {
      Executor executor = ContextCompat.getMainExecutor(getContext());
      BiometricPrompt prompt = new BiometricPrompt(
          getActivity(),
          executor,
          new BiometricPrompt.AuthenticationCallback() {
            @Override
            public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
              super.onAuthenticationSucceeded(result);
              JSObject ret = new JSObject();
              ret.put("authenticated", true);
              call.resolve(ret);
            }

            @Override
            public void onAuthenticationError(int errorCode, @NonNull CharSequence errString) {
              super.onAuthenticationError(errorCode, errString);
              call.reject(errString.toString(), String.valueOf(errorCode));
            }

            @Override
            public void onAuthenticationFailed() {
              super.onAuthenticationFailed();
              // Sistema permite tentar novamente até atingir o limite
            }
          }
      );

      BiometricPrompt.PromptInfo promptInfo = new BiometricPrompt.PromptInfo.Builder()
          .setTitle(title)
          .setSubtitle(subtitle)
          .setAllowedAuthenticators(ALLOWED_AUTHENTICATORS)
          .build();

      prompt.authenticate(promptInfo);
    });
  }

  @PluginMethod
  public void openNotificationSettings(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      try {
        Intent intent = new Intent();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          intent.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
          intent.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        } else {
          intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
          intent.setData(Uri.fromParts("package", getContext().getPackageName(), null));
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
      } catch (Exception e) {
        call.reject("Não foi possível abrir as configurações de notificação do Android.", e);
      }
    });
  }
}

