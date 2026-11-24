// src/components/layout/FloatingComposeDock.tsx
'use client';

import React from 'react';
import { FilePlus2, MessageSquarePlus } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import CreatePostDialogContent from '@/components/feed/CreatePostDialogContent';
import CreateNewsDialogContent from '@/components/feed/CreateNewsDialogContent';
import type { Post, User } from '@/lib/types';
import { triggerHapticFeedback } from '@/lib/utils';

interface FloatingComposeDockProps {
  currentUser: User | null | undefined;
  isLoadingCurrentUser: boolean;
  isCreatePostDialogOpen: boolean;
  setIsCreatePostDialogOpen: (open: boolean) => void;
  isCreateNewsDialogOpen: boolean;
  setIsCreateNewsDialogOpen: (open: boolean) => void;
  onPostCreated: (newPost: Post) => void;
  clientHasMounted: boolean;
}

/**
 * Dock flutuante unificado (desktop + mobile) no canto inferior direito
 * para criar publicações e artigos, mantendo o menu lateral limpo no padrão X.
 */
const FloatingComposeDock: React.FC<FloatingComposeDockProps> = ({
  currentUser,
  isLoadingCurrentUser,
  isCreatePostDialogOpen,
  setIsCreatePostDialogOpen,
  isCreateNewsDialogOpen,
  setIsCreateNewsDialogOpen,
  onPostCreated,
  clientHasMounted,
}) => {
  const t = useTranslations('DesktopSidebar');

  if (!clientHasMounted || isLoadingCurrentUser || !currentUser) {
    return null;
  }

  const handleOpenArticle = () => {
    triggerHapticFeedback();
    setIsCreateNewsDialogOpen(true);
  };

  const handleOpenPost = () => {
    triggerHapticFeedback();
    setIsCreatePostDialogOpen(true);
  };

  return (
    <>
      <div
        role="region"
        aria-label={`${t('post')} e ${t('article')}`}
        className="fixed z-40 right-4 bottom-[calc(4rem+0.85rem)] min-[800px]:right-6 min-[800px]:bottom-6 flex flex-col items-center gap-1.5 rounded-2xl border border-border/80 bg-card/90 p-1.5 shadow-[0_14px_38px_-10px_rgba(0,0,0,0.65)] backdrop-blur-md transition-colors duration-300"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('article')}
              aria-haspopup="dialog"
              onClick={handleOpenArticle}
              className="h-11 w-11 rounded-xl bg-muted/70 text-foreground transition-all duration-150 hover:scale-105 hover:bg-primary/15 hover:text-primary active:scale-95"
            >
              <FilePlus2 className="h-5 w-5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            {t('article')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="default"
              size="icon"
              aria-label={t('post')}
              aria-haspopup="dialog"
              onClick={handleOpenPost}
              className="h-12 w-12 rounded-xl bg-primary text-primary-foreground shadow-md shadow-primary/25 transition-all duration-150 hover:scale-105 hover:bg-primary/90 active:scale-95"
            >
              <MessageSquarePlus className="h-5 w-5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={10}>
            {t('post')}
          </TooltipContent>
        </Tooltip>
      </div>

      <Dialog open={isCreatePostDialogOpen} onOpenChange={setIsCreatePostDialogOpen}>
        <CreatePostDialogContent
          onPostCreated={onPostCreated}
          dialogClose={() => setIsCreatePostDialogOpen(false)}
        />
      </Dialog>

      <Dialog open={isCreateNewsDialogOpen} onOpenChange={setIsCreateNewsDialogOpen}>
        <CreateNewsDialogContent
          onPostCreated={onPostCreated}
          dialogClose={() => setIsCreateNewsDialogOpen(false)}
        />
      </Dialog>
    </>
  );
};

export default FloatingComposeDock;
