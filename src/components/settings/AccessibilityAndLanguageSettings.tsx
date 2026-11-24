// src/components/settings/AccessibilityAndLanguageSettings.tsx
'use client';

import React, { useState, useEffect } from 'react';
import type { TranslationPreferences, User } from '@/lib/types';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { updateUserSettings } from '@/lib/services/userService';
import { useToast } from '@/hooks/use-toast';
import {
  persistLocalTranslationPreferences,
  readTranslationPreferences,
  SUPPORTED_TRANSLATION_LANGUAGES,
} from '@/lib/i18n/translationPreferences';
import { cn } from '@/lib/utils';
import {
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import { useTheme } from 'next-themes';
import { switchThemeFluid } from '@/lib/utils/fluidTheme';

interface SettingsProps {
  user: User;
}

const FONT_SIZE_STORAGE_KEY = 'soberan-font-size';
const DEFAULT_FONT_SIZE = 16; // Default base font size in pixels

export default function AccessibilityAndLanguageSettings({ user }: SettingsProps) {
  const t = useTranslations('AccessibilitySettings');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  const [fontSize, setFontSize] = useState(DEFAULT_FONT_SIZE);
  const [isHighContrast, setIsHighContrast] = useState(false);
  const [clientHasMounted, setClientHasMounted] = useState(false);
  const { refreshCurrentUser } = useCurrentUser();
  const { toast } = useToast();
  const [transPrefs, setTransPrefs] = useState<TranslationPreferences>(() =>
    readTranslationPreferences(user),
  );
  const [isSavingTrans, setIsSavingTrans] = useState(false);

  const handleSaveTranslationPrefs = async (next: TranslationPreferences) => {
    setTransPrefs(next);
    persistLocalTranslationPreferences(next);
    if (!user?.id) return;
    setIsSavingTrans(true);
    try {
      await updateUserSettings(user.id, { translationPreferences: next });
      await refreshCurrentUser();
      toast({
        title: 'Tradução atualizada',
        description:
          next.mode === 'auto'
            ? 'Posts e artigos em outros idiomas serão traduzidos automaticamente.'
            : next.mode === 'button'
              ? 'Um botão discreto aparecerá para traduzir textos em outros idiomas.'
              : 'Tradução desativada.',
      });
    } catch {
      toast({
        title: 'Erro ao salvar',
        description: 'Aplicado apenas nesta sessão.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingTrans(false);
    }
  };
  
  // Load settings from localStorage on mount
  useEffect(() => {
    setClientHasMounted(true);

    const storedFontSize = localStorage.getItem(FONT_SIZE_STORAGE_KEY);
    if (storedFontSize) {
      const size = parseInt(storedFontSize, 10);
      if (!isNaN(size)) {
        setFontSize(size);
        document.documentElement.style.fontSize = `${size}px`;
      }
    }
    
    // Theme is managed by next-themes, which handles localStorage automatically.
    // We just need to sync our switch state with it.
    setIsHighContrast(theme === 'high-contrast');
    
  }, [theme]);


  const handleLocaleChange = (newLocale: string) => {
    const currentPathWithoutLocale = pathname.replace(`/${locale}`, '');
    const newPath = `/${newLocale}${currentPathWithoutLocale}`;
    router.push(newPath);
  };

  const handleFontSizeChange = (value: number[]) => {
    const newSize = value[0];
    setFontSize(newSize);
    document.documentElement.style.fontSize = `${newSize}px`;
    localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(newSize));
  };
  
  const handleHighContrastToggle = (checked: boolean) => {
    setIsHighContrast(checked);
    if (checked) {
      switchThemeFluid(setTheme, 'high-contrast');
    } else {
      // Revert to the default theme (e.g., 'dark') or a previously stored one
      switchThemeFluid(setTheme, 'dark'); 
    }
  };


  const title = t('title');
  const description = t('description');

  return (
    <>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        
        <div className="space-y-2">
            <h3 className="text-base font-semibold">{t('languageLabel')}</h3>
            <p className="text-sm text-muted-foreground">
                {t('languageDescription')}
            </p>
            <Select value={locale} onValueChange={handleLocaleChange}>
                <SelectTrigger id="language-select" className="w-[280px]">
                <SelectValue placeholder={t('selectPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                <SelectItem value="pt-BR">Português (Brasil)</SelectItem>
                <SelectItem value="en">English</SelectItem>
                </SelectContent>
            </Select>
        </div>

        <Separator />

        <div className="space-y-4">
          <div>
            <h3 className="text-base font-semibold">Tradução de Posts, Artigos e Citações</h3>
            <p className="text-sm text-muted-foreground">
              Tradução integrada com software livre (LibreTranslate / Lingva). Disponível para sua conta logada.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-medium">Modo de tradução</Label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 max-w-lg">
              {([
                { value: 'button', label: 'Botão em cada post' },
                { value: 'auto', label: 'Automática' },
                { value: 'off', label: 'Desativada' },
              ] as const).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={isSavingTrans}
                  onClick={() => void handleSaveTranslationPrefs({ ...transPrefs, mode: opt.value })}
                  className={cn(
                    'rounded-md border px-3 py-2 text-xs font-medium transition-colors',
                    transPrefs.mode === opt.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {transPrefs.mode !== 'off' && (
            <>
              <div className="space-y-2">
                <Label htmlFor="translation-target-select">Traduzir textos para</Label>
                <Select
                  value={transPrefs.targetLanguage}
                  disabled={isSavingTrans}
                  onValueChange={(value) =>
                    void handleSaveTranslationPrefs({ ...transPrefs, targetLanguage: value })
                  }
                >
                  <SelectTrigger id="translation-target-select" className="w-[280px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automático (idioma do navegador)</SelectItem>
                    {SUPPORTED_TRANSLATION_LANGUAGES.map((lang) => (
                      <SelectItem key={lang.code} value={lang.code}>
                        {lang.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-between rounded-lg border p-4">
                <div className="space-y-0.5 pr-4">
                  <Label htmlFor="auto-detect-browser-lang" className="text-sm font-medium">
                    Identificar meu idioma pelo navegador
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Quando o destino estiver em Automático, usa o idioma configurado no seu navegador.
                  </p>
                </div>
                <Switch
                  id="auto-detect-browser-lang"
                  checked={transPrefs.allowAutoDetectBrowserLang}
                  disabled={isSavingTrans}
                  onCheckedChange={(checked) =>
                    void handleSaveTranslationPrefs({
                      ...transPrefs,
                      allowAutoDetectBrowserLang: checked,
                    })
                  }
                />
              </div>
            </>
          )}
        </div>

        <Separator />
        
        <div className="space-y-6">
            <h3 className="text-base font-semibold">{t('displayTitle')}</h3>
            
            <div className="space-y-2">
                 <Label htmlFor="font-size-slider">{t('fontSize')}</Label>
                 <div className="flex items-center gap-4">
                    <span className="text-xs">Pequeno</span>
                    <Slider
                        id="font-size-slider"
                        min={12}
                        max={20}
                        step={1}
                        value={[fontSize]}
                        onValueChange={handleFontSizeChange}
                        className="w-[150px]"
                    />
                     <span className="text-lg">Grande</span>
                 </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
                 <div className="space-y-0.5">
                    <Label htmlFor="high-contrast-switch" className="text-base">{t('highContrast')}</Label>
                    <p className="text-sm text-muted-foreground">{t('highContrastDescription')}</p>
                </div>
                {clientHasMounted && (
                  <Switch
                      id="high-contrast-switch"
                      checked={isHighContrast}
                      onCheckedChange={handleHighContrastToggle}
                  />
                )}
            </div>
        </div>
      </CardContent>
    </>
  );
}
