// src/components/layout/GlobalSearch.tsx
'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "@/components/ui/popover";
import { performGlobalSearch, type SearchResult } from '@/lib/services/searchService';
import { useDebounce } from '@/hooks/use-debounce';
import { Loader2, Search, Hash, User as UserIcon, History, X, Globe, ExternalLink } from 'lucide-react';
import { classifySearchQuery } from '@/lib/search/searchQueryParser';
import { notifyNavigationStart } from '@/components/layout/NavigationProgress';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale } from 'next-intl';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';

const MAX_HISTORY_ITEMS = 5;

interface GlobalSearchProps {
  isExpanded: boolean;
  setIsExpanded: (expanded: boolean) => void;
  alwaysExpanded?: boolean;
}

interface RemoteLookupPreview {
  handle: string;
  domain: string;
  name: string;
  iconUrl: string | null;
}

export default function GlobalSearch({ isExpanded, setIsExpanded, alwaysExpanded = false }: GlobalSearchProps) {
  const t = useTranslations('GlobalSearch');
  const [searchQuery, setSearchQuery] = useState('');
  const [results, setResults] = useState<SearchResult | null>(null);
  const [remoteLookup, setRemoteLookup] = useState<RemoteLookupPreview | null>(null);
  const [localUrlPath, setLocalUrlPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);
  const locale = useLocale();
  const isMobile = useIsMobile();
  
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isExpanded && !alwaysExpanded) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isExpanded, alwaysExpanded]);
  
  // Close search on outside click, ignoring clicks inside the popover content
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node;
      // Check if the click is outside the main container AND not inside the popover content
      if (
        containerRef.current &&
        !containerRef.current.contains(target) &&
        !target.parentElement?.closest('[data-radix-popper-content-wrapper]')
      ) {
        if (!alwaysExpanded) {
          setIsExpanded(false);
        }
        setIsPopoverOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [containerRef, setIsExpanded, alwaysExpanded]);

  useEffect(() => {
    try {
      const storedHistory = localStorage.getItem('searchHistory');
      if (storedHistory) setSearchHistory(JSON.parse(storedHistory));
    } catch (error) {
      console.error("Failed to parse search history:", error);
      localStorage.removeItem('searchHistory');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const search = async () => {
      const trimmed = debouncedSearchQuery.trim();
      if (trimmed.length > 1) {
        setIsLoading(true);
        setRemoteLookup(null);
        setLocalUrlPath(null);

        const classified = classifySearchQuery(trimmed);
        if (classified.kind === 'local-url') {
          if (!cancelled) {
            setLocalUrlPath(classified.path);
            setResults({ users: [], hashtags: [] });
            setIsLoading(false);
            setIsPopoverOpen(true);
          }
          return;
        }

        const shouldLookupRemote =
          classified.kind === 'fediverse-handle' || classified.kind === 'fediverse-profile-url';

        const [searchResults, fediRes] = await Promise.all([
          performGlobalSearch(trimmed),
          shouldLookupRemote
            ? fetch(`/api/ap/lookup?q=${encodeURIComponent(trimmed)}`)
                .then((r) => (r.ok ? r.json() : null))
                .catch(() => null)
            : Promise.resolve(null),
        ]);

        if (!cancelled) {
          setResults(searchResults);
          if (fediRes && typeof fediRes.handle === 'string') {
            setRemoteLookup({
              handle: fediRes.handle,
              domain: fediRes.domain,
              name: fediRes.name,
              iconUrl: fediRes.iconUrl ?? null,
            });
          }
          setIsLoading(false);
          setIsPopoverOpen(true);
        }
      } else {
        setResults(null);
        setRemoteLookup(null);
        setLocalUrlPath(null);
        if (searchQuery.length === 0 && searchHistory.length === 0) {
          setIsPopoverOpen(false);
        }
      }
    };
    void search();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearchQuery, searchQuery.length, searchHistory.length]);

  const addToHistory = (term: string) => {
    const newHistory = [term, ...searchHistory.filter(item => item.toLowerCase() !== term.toLowerCase())]
      .slice(0, MAX_HISTORY_ITEMS);
    setSearchHistory(newHistory);
    localStorage.setItem('searchHistory', JSON.stringify(newHistory));
  };

  const removeFromHistory = (e: React.MouseEvent, termToRemove: string) => {
    e.stopPropagation(); e.preventDefault();
    const newHistory = searchHistory.filter(item => item !== termToRemove);
    setSearchHistory(newHistory);
    localStorage.setItem('searchHistory', JSON.stringify(newHistory));
  };

  const handleSearchSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const term = searchQuery.trim();
    if (term) {
      addToHistory(term);
      setIsPopoverOpen(false);
      if (!alwaysExpanded) {
        setIsExpanded(false);
      }
      const classified = classifySearchQuery(term);
      if (classified.kind === 'local-url') {
        notifyNavigationStart();
        router.push(classified.path);
        return;
      }
      // Use router.push for client-side navigation without a full page reload.
      notifyNavigationStart();
      router.push(`/${locale}/search?q=${encodeURIComponent(term)}`);
    }
  };
  
  const handleSelect = (url: string, term?: string) => {
    setIsPopoverOpen(false);
    if (!alwaysExpanded) {
      setIsExpanded(false);
    }
    if (term) addToHistory(term);
    // Use router.push for client-side navigation.
    notifyNavigationStart();
    router.push(url);
    setSearchQuery('');
  };
  
  const handleFocus = () => {
    if (searchQuery.length === 0 && searchHistory.length > 0) {
      setIsPopoverOpen(true);
    } else if (debouncedSearchQuery.length > 1) {
      setIsPopoverOpen(true);
    }
  };

  const showHistory = searchQuery.length === 0 && searchHistory.length > 0;
  const showResults = searchQuery.length > 1;
  
  if (!isExpanded && !alwaysExpanded) {
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setIsExpanded(true)}
        className="rounded-full h-9 w-9"
      >
        <Search className="h-5 w-5" />
        <span className="sr-only">Search</span>
      </Button>
    );
  }

  return (
    <div ref={containerRef} className={cn('relative w-full', !alwaysExpanded && 'max-w-sm sm:max-w-md')}>
       <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
        <PopoverAnchor asChild>
          <form onSubmit={handleSearchSubmit} className="relative w-full flex items-center">
            <Search
              className={cn(
                'absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none',
                alwaysExpanded ? 'left-3.5' : 'left-3'
              )}
            />
            <Input
              ref={inputRef}
              type="search"
              placeholder={t('placeholder')}
              className={cn(
                'w-full transition-all',
                alwaysExpanded
                  ? 'h-10 rounded-full border border-border/70 bg-muted/40 pl-10 text-sm focus-visible:bg-background focus-visible:border-primary/60'
                  : 'h-9 rounded-full text-sm pl-9 bg-muted'
              )}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={handleFocus}
            />
          </form>
        </PopoverAnchor>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] mt-2 p-2"
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {showHistory && (
            <div className="space-y-2">
              <div className="flex justify-between items-center px-2">
                <h4 className="font-semibold text-sm flex items-center"><History className="mr-2 h-4 w-4"/>{t('recent')}</h4>
                <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => { setSearchHistory([]); localStorage.setItem('searchHistory', '[]'); }}>{t('clear')}</Button>
              </div>
              {searchHistory.map(term => (
                <div key={term} onClick={() => handleSelect(`/${locale}/search?q=${encodeURIComponent(term)}`, term)} className="flex items-center justify-between p-2 rounded-md hover:bg-accent transition-colors cursor-pointer group">
                  <div className="flex items-center gap-3">
                    <History className="h-4 w-4 text-muted-foreground" />
                    <p className="text-sm font-medium leading-none">{term}</p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-6 w-6 opacity-0 group-hover:opacity-100" onClick={(e) => removeFromHistory(e, term)}>
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
          
          {showResults && (
            <>
              {isLoading ? (
                <div className="space-y-4 p-2">
                  {[...Array(2)].map((_, i) => (
                    <div key={i} className="flex items-center space-x-2">
                      <Skeleton className="h-8 w-8 rounded-full" />
                      <Skeleton className="h-4 w-3/4" />
                    </div>
                  ))}
                </div>
              ) : (localUrlPath || remoteLookup || (results && (results.users.length > 0 || results.hashtags.length > 0))) ? (
                <div className="space-y-4">
                  {localUrlPath && (
                    <div
                      onClick={() => handleSelect(localUrlPath, searchQuery.trim())}
                      className="flex items-center gap-3 p-2.5 rounded-md border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors cursor-pointer"
                    >
                      <ExternalLink className="h-4 w-4 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium leading-none">Abrir link no HiperVerso</p>
                        <p className="text-xs text-muted-foreground truncate mt-1 font-mono">{localUrlPath}</p>
                      </div>
                    </div>
                  )}
                  {remoteLookup && (
                    <div className="space-y-2">
                      <h4 className="font-semibold text-sm px-2 flex items-center">
                        <Globe className="mr-2 h-4 w-4 text-primary" />
                        Fediverso ({remoteLookup.domain})
                      </h4>
                      <div
                        onClick={() => handleSelect(`/${locale}/fediverse/${encodeURIComponent(remoteLookup.handle)}`, `@${remoteLookup.handle}`)}
                        className="flex items-center gap-3 p-2 rounded-md hover:bg-accent transition-colors cursor-pointer"
                      >
                        <Avatar className="h-8 w-8">
                          {remoteLookup.iconUrl && <AvatarImage src={remoteLookup.iconUrl} alt={remoteLookup.name} />}
                          <AvatarFallback>{remoteLookup.name?.[0] || '?'}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="text-sm font-medium leading-none truncate">{remoteLookup.name}</p>
                          <p className="text-xs text-muted-foreground truncate">@{remoteLookup.handle}</p>
                        </div>
                      </div>
                    </div>
                  )}
                  {results && results.users.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-semibold text-sm px-2 flex items-center"><UserIcon className="mr-2 h-4 w-4"/>{t('users')}</h4>
                      {results.users.map(user => (
                        <div key={user.id} onClick={() => handleSelect(`/${locale}/profile/${user.id}`, `@${user.username}`)} className="flex items-center gap-3 p-2 rounded-md hover:bg-accent transition-colors cursor-pointer">
                          <Avatar className="h-8 w-8">
                            <AvatarImage src={user.avatarUrl} alt={user.name} />
                            <AvatarFallback>{user.name?.[0]}</AvatarFallback>
                          </Avatar>
                          <div>
                            <p className="text-sm font-medium leading-none">{user.name}</p>
                            <p className="text-xs text-muted-foreground">@{user.username}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {results && results.hashtags.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-semibold text-sm px-2 flex items-center"><Hash className="mr-2 h-4 w-4"/>{t('topics')}</h4>
                      {results.hashtags.map((tag) => (
                        <div key={tag} onClick={() => handleSelect(`/${locale}/tag/${tag.substring(1)}`, tag)} className="block p-2 rounded-md hover:bg-accent transition-colors cursor-pointer">
                          <p className="text-sm font-medium">{tag}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : debouncedSearchQuery.length > 1 ? (
                <p className="text-sm text-center text-muted-foreground py-4">{t('noResults', { query: debouncedSearchQuery })}</p>
              ) : null }
            </>
          )}

        </PopoverContent>
      </Popover>
    </div>
  );
}
