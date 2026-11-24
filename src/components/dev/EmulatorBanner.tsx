'use client';

import { useEffect, useState } from 'react';
import { checkEmulatorsRunning, type EmulatorStatus } from '@/lib/firebase-emulators';

/**
 * Aviso fixo exibido SOMENTE no modo emulador (ver src/app/[locale]/layout.tsx):
 * confirma que o app está nos emuladores ou denuncia claramente que eles não estão rodando.
 */
export default function EmulatorBanner() {
  const [status, setStatus] = useState<EmulatorStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkEmulatorsRunning().then((result) => {
      if (cancelled) return;
      setStatus(result);
      if (result.ok) {
        console.info('[emuladores] Conectado aos emuladores do Firebase (projeto de demonstração).');
      } else {
        console.error(
          `[emuladores] ${result.message} O app NÃO usará o projeto real. ` +
            'Inicie os emuladores com "npm run emulators" e recarregue a página.',
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status) return null;

  if (status.ok) {
    return (
      <div
        data-testid="emulator-banner"
        data-status="ok"
        className="sr-only"
      >
        Emuladores Firebase ativos
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-testid="emulator-banner"
      data-status="error"
      className="fixed inset-x-2 bottom-2 z-[2147483647] rounded bg-red-700 px-3 py-2 text-sm text-white"
    >
      <strong>Emuladores Firebase indisponíveis.</strong> {status.message} O app não usará o projeto real.
      Inicie com <code>npm run emulators</code> e recarregue a página.
    </div>
  );
}
