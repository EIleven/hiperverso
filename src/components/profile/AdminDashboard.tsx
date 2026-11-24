// src/components/profile/AdminDashboard.tsx
'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import UserListItem from '@/components/profile/UserListItem';
import HiperChatAdminPanel from '@/components/admin/HiperChatAdminPanel';
import { useToast } from '@/hooks/use-toast';
import type { User, ReportedItem } from '@/lib/types';
import {
  searchUsers as serverSearchUsers,
  subscribeToPresenceStats,
} from '@/lib/services/userService';
import {
  Loader2,
  Search as SearchIcon,
  ShieldAlert,
  Users,
  Newspaper,
  UserCheck,
  UserX,
  BarChart3,
  ChevronRight,
  Globe,
  Activity,
  Sparkles,
  Settings2,
  RefreshCw,
  MessageSquare,
  Heart,
  Repeat2,
  Eye,
  Lock,
  ShieldCheck,
  Hash,
  Rss,
  ExternalLink,
  Layers,
  Info,
} from 'lucide-react';
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip';
import ReportedContentCard from '@/components/moderation/ReportedContentCard';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AreaChart,
  Area,
  BarChart as RechartsBarChart,
  Bar,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  Legend,
} from 'recharts';
import {
  getPageViewsAnalytics,
  getTopRoutesAnalytics,
  getCountryAnalytics,
  getTopStatesAnalytics,
  getTopCitiesAnalytics,
  type AdminRange,
  type TopRouteData,
  type PageViewData,
  type CountryViewData,
  type TopStateData,
  type TopCityData,
} from '@/lib/services/adminService';
import ManageUserRolesDialog from './ManageUserRolesDialog';
import FediverseAdminPanel from '@/components/admin/FediverseAdminPanel';
import OfficialAccountAdminCard from '@/components/admin/OfficialAccountAdminCard';
import ProvenanceAlertsAdminCard from '@/components/profile/ProvenanceAlertsAdminCard';
import { useCurrentUser } from '@/contexts/CurrentUserContext';
import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { ScrollArea, ScrollBar } from '@/components/ui/scroll-area';
import {
  subscribeToReportedContent,
  ignoreReport,
  deleteReportedContent,
} from '@/lib/services/moderationService';
import { cn } from '@/lib/utils';

interface AdminDashboardProps {
  activeUser: User | null;
}

interface IntelligencePostSummary {
  id: string;
  text: string;
  headline: string | null;
  userId: string;
  authorName: string;
  authorUsername: string;
  authorAvatarUrl: string;
  isRemoteFediverse: boolean;
  likes: number;
  commentsCount: number;
  reposts: number;
  quotesCount: number;
  views: number;
  totalEngagements: number;
  createdAt: string;
}

interface IntelligenceUserSummary {
  id: string;
  name: string;
  username: string;
  avatarUrl: string;
  postsCount: number;
  followersCount: number;
  followingCount: number;
  isAdmin: boolean;
  isModerator: boolean;
  createdAt: string;
}

interface IntelligencePayload {
  kpis: {
    localUsersCount: number;
    federatedActorsCount: number;
    totalNetworkActors: number;
    adminsCount: number;
    moderatorsCount: number;
    federationEnabledLocalCount: number;
    localPostsCount: number;
    federatedPostsCount: number;
    totalPostsCount: number;
    echoPostsCount: number;
    newsPostsCount: number;
    mediaPostsCount: number;
    pollPostsCount: number;
    totalLikes: number;
    totalComments: number;
    totalReposts: number;
    totalQuotes: number;
    totalViews: number;
    totalEngagements: number;
    avgEngagementPerPost: number;
    engagementRatePct: number;
    groupsCount: number;
    totalGroupMemberships: number;
  };
  networkBreakdown?: {
    nativeOwnTotal: number;
    nativeFederatedBridge: number;
    nativeLocalOnly: number;
    inSiteOtherProvidersTotal: number;
    inSiteBluesky: number;
    inSiteFediverse: number;
    externalInteractingActors: number;
  };
  accessRealtime?: {
    todayTotal: number;
    todayAuth: number;
    todayGuests: number;
    yesterdayTotal: number;
    periodTotal: number;
    periodAuth: number;
    periodGuests: number;
    periodDailyAvg: number;
    sections: Array<{
      section: string;
      authViews: number;
      guestViews: number;
      totalViews: number;
      sharePct: number;
    }>;
    topPages: Array<{
      path: string;
      section: string;
      authViews: number;
      guestViews: number;
      totalViews: number;
    }>;
  };
  timeSeries: Array<{
    date: string;
    isoDate: string;
    newLocalUsers: number;
    newFederatedActors: number;
    newLocalPosts: number;
    newFederatedPosts: number;
    engagements: number;
  }>;
  contentBreakdown: Array<{ name: string; count: number }>;
  topFediverseDomains: Array<{ domain: string; actorsCount: number; postsCount: number }>;
  topHashtags: Array<{ tag: string; count: number; engagements: number }>;
  topGroups: Array<{ id: string; name: string; membersCount: number }>;
  rankings: {
    topLikedPosts: IntelligencePostSummary[];
    topCommentedPosts: IntelligencePostSummary[];
    topRepostedPosts: IntelligencePostSummary[];
    topViewedPosts: IntelligencePostSummary[];
    mostActiveLocalUsers: IntelligenceUserSummary[];
    topFollowedLocalUsers: IntelligenceUserSummary[];
    recentLocalUsers: IntelligenceUserSummary[];
  };
  config: {
    signup: {
      limit: number;
      used: number;
      issued: number;
      requireAppCheck: boolean;
      open: boolean;
    };
    system: {
      strictAntiBotMode: boolean;
      allowPublicExploreForGuests: boolean;
      p2pDefaultEnabled: boolean;
      maxGroupParticipants: number;
      defaultFeedMode: 'local' | 'federated';
    };
  };
}

const MetricHint = ({ text }: { text: string }) => (
  <UiTooltipProvider delayDuration={150}>
    <UiTooltip>
      <UiTooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-full text-muted-foreground/75 hover:text-foreground focus:outline-none"
          aria-label={text}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </UiTooltipTrigger>
      <UiTooltipContent side="top" className="max-w-[260px] text-xs leading-relaxed">
        {text}
      </UiTooltipContent>
    </UiTooltip>
  </UiTooltipProvider>
);

const GeoAnalyticsTable = ({
  data,
  total,
  locationType,
}: {
  data: any[];
  total: number;
  locationType: 'country' | 'state' | 'city';
}) => {
  if (!data || data.length === 0) {
    return (
      <div className="border border-border/70 rounded-xl h-[340px] flex items-center justify-center text-muted-foreground text-sm">
        <p>Nenhum dado geográfico registrado no período.</p>
      </div>
    );
  }
  const locationKey =
    data[0] && `${locationType}Name` in data[0] ? `${locationType}Name` : locationType;
  const codeKey = `${locationType}Code`;

  return (
    <div className="border border-border/70 rounded-xl max-h-[340px] overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Localização</TableHead>
            <TableHead className="text-right">Visualizações</TableHead>
            <TableHead className="text-right">%</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.map((item) => (
            <TableRow key={item[codeKey] || item[locationKey]}>
              <TableCell className="font-medium">{item[locationKey]}</TableCell>
              <TableCell className="text-right">{item.views.toLocaleString()}</TableCell>
              <TableCell className="text-right">
                {total > 0 ? ((item.views / total) * 100).toFixed(1) : '0.0'}%
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};

export default function AdminDashboard({ activeUser }: AdminDashboardProps) {
  const { firebaseUser } = useCurrentUser();
  const { toast } = useToast();
  const t = useTranslations('AdminDashboard');
  const locale = useLocale();
  const [activeTab, setActiveTab] = useState(activeUser?.isAdmin ? 'command' : 'usersAndMod');
  const [rankingSubTab, setRankingSubTab] = useState<
    'viewed' | 'liked' | 'commented' | 'reposted' | 'activeUsers' | 'newUsers'
  >('viewed');

  const [analyticsRange, setAnalyticsRange] = useState<AdminRange>('7d');

  // Presence RTDB
  const [activeUsers, setActiveUsers] = useState<number | null>(null);
  const [unauthenticatedActiveUsers, setUnauthenticatedActiveUsers] = useState<number | null>(null);

  // Unified Intelligence State
  const [intel, setIntel] = useState<IntelligencePayload | null>(null);
  const [isLoadingIntel, setIsLoadingIntel] = useState(true);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [signupLimitInput, setSignupLimitInput] = useState('500');
  const [maxGroupInput, setMaxGroupInput] = useState('1000');

  // Access Analytics State
  const [pageViews, setPageViews] = useState<PageViewData[]>([]);
  const [isLoadingPageViews, setIsLoadingPageViews] = useState(false);
  const [topRoutesData, setTopRoutesData] = useState<TopRouteData[]>([]);
  const [isLoadingTopRoutes, setIsLoadingTopRoutes] = useState(false);
  const [countryViews, setCountryViews] = useState<CountryViewData[]>([]);
  const [isLoadingCountryViews, setIsLoadingCountryViews] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<{ code: string; name: string } | null>(
    null
  );
  const [topStates, setTopStates] = useState<TopStateData[]>([]);
  const [isLoadingTopStates, setIsLoadingTopStates] = useState(false);
  const [selectedState, setSelectedState] = useState<{ code: string; name: string } | null>(null);
  const [topCities, setTopCities] = useState<TopCityData[]>([]);
  const [isLoadingTopCities, setIsLoadingTopCities] = useState(false);
  const [audienceTypeFilter, setAudienceTypeFilter] = useState<'all' | 'auth' | 'guest'>('all');

  // User Management & Moderation
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userSearchResults, setUserSearchResults] = useState<User[]>([]);
  const [isSearchingUsers, setIsSearchingUsers] = useState(false);
  const [userToManage, setUserToManage] = useState<User | null>(null);
  const [staffMembers, setStaffMembers] = useState<User[]>([]);
  const [isLoadingStaff, setIsLoadingStaff] = useState(false);
  const [reportedItems, setReportedItems] = useState<ReportedItem[]>([]);
  const [isLoadingReports, setIsLoadingReports] = useState(true);

  const loadStaff = useCallback(async () => {
    if (!firebaseUser || !activeUser?.isAdmin) return;
    setIsLoadingStaff(true);
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/admin/roles', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return;
      const json = (await res.json()) as { staff?: User[] };
      setStaffMembers(Array.isArray(json.staff) ? json.staff : []);
    } catch {
      // silencioso: equipe pode ser carregada novamente ao abrir a aba
    } finally {
      setIsLoadingStaff(false);
    }
  }, [firebaseUser, activeUser?.isAdmin]);

  const loadIntelligence = useCallback(
    async (range: AdminRange = analyticsRange) => {
      if (!firebaseUser || !activeUser?.isAdmin) return;
      setIsLoadingIntel(true);
      try {
        const token = await firebaseUser.getIdToken();
        const res = await fetch(`/api/admin/intelligence?range=${range}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as IntelligencePayload;
        setIntel(data);
        setSignupLimitInput(String(data.config.signup.limit));
        setMaxGroupInput(String(data.config.system.maxGroupParticipants));
      } catch (err) {
        console.error('Error fetching admin intelligence:', err);
        toast({
          title: 'Erro ao carregar inteligência da rede',
          description: 'Tente atualizar novamente.',
          variant: 'destructive',
        });
      } finally {
        setIsLoadingIntel(false);
      }
    },
    [firebaseUser, activeUser?.isAdmin, analyticsRange, toast]
  );

  useEffect(() => {
    if (activeUser?.isAdmin && firebaseUser) {
      void loadIntelligence(analyticsRange);
    }
  }, [activeUser?.isAdmin, firebaseUser, analyticsRange, loadIntelligence]);

  useEffect(() => {
    if (activeUser?.isAdmin) {
      const unsubPresence = subscribeToPresenceStats(({ onlineUsers, onlineGuests }) => {
        setActiveUsers(onlineUsers);
        setUnauthenticatedActiveUsers(onlineGuests);
      });
      return () => {
        unsubPresence();
      };
    }
  }, [activeUser]);

  // Fetch access charts data
  useEffect(() => {
    const fetchAccessAnalytics = async () => {
      if (activeTab === 'access' && activeUser?.isAdmin) {
        setIsLoadingPageViews(true);
        setIsLoadingTopRoutes(true);
        setIsLoadingCountryViews(true);
        setSelectedCountry(null);
        setSelectedState(null);
        try {
          const [viewsData, routesData, countryData] = await Promise.all([
            getPageViewsAnalytics(analyticsRange),
            getTopRoutesAnalytics(analyticsRange),
            getCountryAnalytics(analyticsRange),
          ]);
          setPageViews(viewsData);
          setTopRoutesData(routesData);
          setCountryViews(countryData);
        } catch (error) {
          console.error('Error fetching access analytics:', error);
          toast({ title: t('accessError'), variant: 'destructive' });
        } finally {
          setIsLoadingPageViews(false);
          setIsLoadingTopRoutes(false);
          setIsLoadingCountryViews(false);
        }
      }
    };
    void fetchAccessAnalytics();
  }, [activeTab, activeUser?.isAdmin, analyticsRange, toast, t]);

  useEffect(() => {
    const fetchStates = async () => {
      if (selectedCountry) {
        setIsLoadingTopStates(true);
        try {
          const statesData = await getTopStatesAnalytics(analyticsRange, selectedCountry.code);
          setTopStates(statesData);
        } catch (error) {
          console.error('Error fetching states:', error);
        } finally {
          setIsLoadingTopStates(false);
        }
      }
    };
    void fetchStates();
  }, [selectedCountry, analyticsRange]);

  useEffect(() => {
    const fetchCities = async () => {
      if (selectedState && selectedCountry) {
        setIsLoadingTopCities(true);
        try {
          const citiesData = await getTopCitiesAnalytics(
            analyticsRange,
            selectedCountry.code,
            selectedState.code
          );
          setTopCities(citiesData);
        } catch (error) {
          console.error('Error fetching cities:', error);
        } finally {
          setIsLoadingTopCities(false);
        }
      }
    };
    void fetchCities();
  }, [selectedState, selectedCountry, analyticsRange]);

  useEffect(() => {
    if (activeUser?.isAdmin && firebaseUser) {
      void loadStaff();
    }
  }, [activeUser?.isAdmin, firebaseUser, loadStaff]);

  useEffect(() => {
    if (activeUser?.isAdmin || activeUser?.isModerator) {
      setIsLoadingReports(true);
      const unsubscribe = subscribeToReportedContent(
        (items) => {
          setReportedItems(items);
          setIsLoadingReports(false);
        },
        () => {
          setIsLoadingReports(false);
        }
      );
      return () => {
        if (unsubscribe) unsubscribe();
      };
    }
  }, [activeUser?.isAdmin, activeUser?.isModerator]);

  const handleSaveSignupConfig = async (patch: { limit?: number; requireAppCheck?: boolean }) => {
    if (!firebaseUser || isSavingConfig) return;
    setIsSavingConfig(true);
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/admin/intelligence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ section: 'signup', ...patch }),
      });
      if (!res.ok) throw new Error('Falha ao salvar configuração de cadastro.');
      toast({ title: 'Controle de cadastro atualizado!' });
      await loadIntelligence(analyticsRange);
    } catch (err) {
      toast({
        title: 'Erro ao salvar',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleSaveSystemConfig = async (patch: Record<string, unknown>) => {
    if (!firebaseUser || isSavingConfig) return;
    setIsSavingConfig(true);
    try {
      const token = await firebaseUser.getIdToken();
      const res = await fetch('/api/admin/intelligence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ section: 'system', ...patch }),
      });
      if (!res.ok) throw new Error('Falha ao salvar configuração operacional.');
      toast({ title: 'Configuração operacional atualizada!' });
      await loadIntelligence(analyticsRange);
    } catch (err) {
      toast({
        title: 'Erro ao salvar',
        description: err instanceof Error ? err.message : 'Tente novamente.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingConfig(false);
    }
  };

  const handleUserSearch = async (e?: React.FormEvent<HTMLFormElement>) => {
    e?.preventDefault();
    if (!userSearchQuery.trim()) return;
    setIsSearchingUsers(true);
    try {
      const results = await serverSearchUsers(userSearchQuery.trim(), activeUser?.id || null);
      setUserSearchResults(results.filter((u) => u.id !== 'adminUserSoberan'));
    } catch {
      toast({
        title: 'Falha na busca',
        description: 'Não foi possível buscar usuários.',
        variant: 'destructive',
      });
    } finally {
      setIsSearchingUsers(false);
    }
  };

  const handleManageRoles = (user: User) => {
    setUserToManage(user);
  };

  const handleUserUpdated = (updatedUser: Partial<User>) => {
    setUserSearchResults((prev) =>
      prev.map((u) => (u.id === updatedUser.id ? ({ ...u, ...updatedUser } as User) : u))
    );
    setUserToManage(null);
    void loadStaff();
  };

  const handleUserDeleted = (deletedUserId: string) => {
    setUserSearchResults((prev) => prev.filter((u) => u.id !== deletedUserId));
    setUserToManage(null);
    void loadStaff();
  };

  const handleIgnoreReport = async (reportId: string) => {
    try {
      await ignoreReport(reportId);
      toast({ title: 'Reporte ignorado' });
    } catch {
      toast({ title: 'Erro ao ignorar reporte', variant: 'destructive' });
    }
  };

  const handleRemoveContent = async (_reportId: string, item: ReportedItem) => {
    try {
      await deleteReportedContent(item);
      toast({ title: 'Conteúdo removido' });
    } catch {
      toast({ title: 'Erro ao remover conteúdo', variant: 'destructive' });
    }
  };

  const handleCountryClick = (data: any) => {
    if (data?.activePayload?.[0]) {
      const payload = data.activePayload[0].payload;
      setSelectedCountry({ code: payload.countryCode, name: payload.countryName });
      setSelectedState(null);
    }
  };

  const handleStateClick = (data: any) => {
    if (data?.activePayload?.[0]) {
      const payload = data.activePayload[0].payload;
      setSelectedState({ code: payload.stateCode, name: payload.stateName });
    }
  };

  const audienceFilterMap = {
    all: { key: 'views', label: t('all') },
    auth: { key: 'authViews', label: t('auth') },
    guest: { key: 'guestViews', label: t('guests') },
  };

  const processGeoData = (data: any[], key: 'views' | 'authViews' | 'guestViews') => {
    if (!data) return { data: [], total: 0 };
    const processed = data
      .map((item) => ({ ...item, views: item[key] || 0 }))
      .filter((item) => item.views > 0);
    const total = processed.reduce((sum, item) => sum + item.views, 0);
    return { data: processed, total };
  };

  const processedCountryData = useMemo(
    () => processGeoData(countryViews, audienceFilterMap[audienceTypeFilter].key as any),
    [countryViews, audienceTypeFilter]
  );
  const processedStateData = useMemo(
    () => processGeoData(topStates, audienceFilterMap[audienceTypeFilter].key as any),
    [topStates, audienceTypeFilter]
  );
  const processedCityData = useMemo(
    () => processGeoData(topCities, audienceFilterMap[audienceTypeFilter].key as any),
    [topCities, audienceTypeFilter]
  );

  const kpis = intel?.kpis;
  const signupCfg = intel?.config.signup;
  const sysCfg = intel?.config.system;

  return (
    <>
      {userToManage && (
        <ManageUserRolesDialog
          user={userToManage}
          onOpenChange={(isOpen) => {
            if (!isOpen) setUserToManage(null);
          }}
          onUserUpdated={handleUserUpdated}
          onUserDeleted={handleUserDeleted}
        />
      )}

      <div className="w-full max-w-6xl mx-auto py-4 px-3 sm:px-5 space-y-5">
        {/* Top Command Header */}
        <div className="relative overflow-hidden rounded-2xl border border-border/80 bg-[radial-gradient(120%_100%_at_0%_0%,hsl(var(--primary)/0.16),transparent_65%)] p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-primary/35 bg-primary/10">
                <span className="text-sm font-black tracking-tight text-primary">HV</span>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg sm:text-xl font-extrabold tracking-tight text-foreground">
                    Centro de Comando HiperVerso
                  </h1>
                  <Badge variant="outline" className="border-primary/40 text-primary text-[10px]">
                    Dados Auditados · Privacidade Preservada
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Visão unificada da malha local, Fediverso, comunidades e governança em tempo real.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 shrink-0">
              {(['7d', '30d', '90d'] as AdminRange[]).map((r) => (
                <Button
                  key={r}
                  size="sm"
                  variant={analyticsRange === r ? 'default' : 'outline'}
                  onClick={() => setAnalyticsRange(r)}
                  className="h-8 rounded-full px-3 text-xs font-semibold"
                >
                  {r}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                onClick={() => void loadIntelligence(analyticsRange)}
                disabled={isLoadingIntel}
                className="h-8 rounded-full px-3 text-xs"
              >
                <RefreshCw className={cn('h-3.5 w-3.5 mr-1', isLoadingIntel && 'animate-spin')} />
                Atualizar
              </Button>
            </div>
          </div>
        </div>

        <Tabs
          defaultValue="command"
          value={activeTab}
          onValueChange={(value) => setActiveTab(value)}
          className="w-full"
        >
          <ScrollArea className="w-full whitespace-nowrap">
            <TabsList className="inline-flex h-auto w-full justify-start sm:justify-center gap-1 rounded-2xl border border-border/80 bg-muted/30 p-1">
              {activeUser?.isAdmin && (
                <>
                  <TabsTrigger value="command" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                    <BarChart3 className="h-3.5 w-3.5 mr-1.5" />
                    Visão Geral &amp; Estatísticas
                  </TabsTrigger>
                  <TabsTrigger value="governance" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                    <Settings2 className="h-3.5 w-3.5 mr-1.5" />
                    Configurações &amp; Limites
                  </TabsTrigger>
                  <TabsTrigger value="access" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                    <Activity className="h-3.5 w-3.5 mr-1.5" />
                    Acessos &amp; Geografia
                  </TabsTrigger>
                  <TabsTrigger value="fediverse" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                    <Globe className="h-3.5 w-3.5 mr-1.5" />
                    Fediverso &amp; Oficial
                  </TabsTrigger>
                  <TabsTrigger value="hiperchat" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                    <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
                    HiperChat
                  </TabsTrigger>
                </>
              )}
              <TabsTrigger value="usersAndMod" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                <Users className="h-3.5 w-3.5 mr-1.5" />
                {activeUser?.isAdmin ? 'Usuários & Moderação' : 'Moderação'}
                {reportedItems.length > 0 && (
                  <span className="ml-1.5 rounded-full bg-destructive px-1.5 py-0.2 text-[10px] text-destructive-foreground">
                    {reportedItems.length}
                  </span>
                )}
              </TabsTrigger>
              {activeUser?.isAdmin && (
                <TabsTrigger value="provenance" className="rounded-xl text-xs sm:text-sm px-3 py-1.5">
                  <ShieldAlert className="h-3.5 w-3.5 mr-1.5" />
                  Proveniência
                </TabsTrigger>
              )}
            </TabsList>
            <ScrollBar orientation="horizontal" className="h-2" />
          </ScrollArea>

          {/* TAB 1: UNIFIED OVERVIEW + APP STATISTICS */}
          <TabsContent value="command" className="mt-4 space-y-5">
            {/* 8 KPI Cards Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Contas Nativas (Locais)</span>
                    <Users className="h-4 w-4 text-primary" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-16" />
                    ) : (
                      (kpis?.localUsersCount ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    {signupCfg
                      ? `${signupCfg.used}/${signupCfg.limit} vagas · ${
                          signupCfg.open ? 'Aberto' : 'Lotado'
                        }`
                      : 'Contas criadas na plataforma'}
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Malha Federada (ap_)</span>
                    <Globe className="h-4 w-4 text-sky-400" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-20" />
                    ) : (
                      (kpis?.federatedActorsCount ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    Total na malha: {(kpis?.totalNetworkActors ?? 0).toLocaleString()} perfis
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Online Agora (RTDB)</span>
                    <UserCheck className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-2xl font-extrabold text-foreground">
                      {activeUsers === null ? (
                        <Skeleton className="h-7 w-12" />
                      ) : (
                        activeUsers.toLocaleString()
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      + {(unauthenticatedActiveUsers ?? 0).toLocaleString()} visitantes
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    Presença efêmera sem rastrear IP
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Publicações Ativas</span>
                    <Newspaper className="h-4 w-4 text-amber-400" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-20" />
                    ) : (
                      (kpis?.totalPostsCount ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    {(kpis?.localPostsCount ?? 0).toLocaleString()} locais ·{' '}
                    {(kpis?.federatedPostsCount ?? 0).toLocaleString()} federados
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Interações Somadas</span>
                    <Heart className="h-4 w-4 text-rose-400" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-20" />
                    ) : (
                      (kpis?.totalEngagements ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    {(kpis?.totalLikes ?? 0).toLocaleString()} ♥ ·{' '}
                    {(kpis?.totalComments ?? 0).toLocaleString()} 💬 ·{' '}
                    {(kpis?.totalReposts ?? 0).toLocaleString()} 🔁
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Leituras Únicas (TTL 90d)</span>
                    <Eye className="h-4 w-4 text-indigo-400" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-20" />
                    ) : (
                      (kpis?.totalViews ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    Média {kpis?.avgEngagementPerPost ?? 0} interações/post
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Grupos &amp; Rodas P2P</span>
                    <MessageSquare className="h-4 w-4 text-emerald-400" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-16" />
                    ) : (
                      (kpis?.groupsCount ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    {(kpis?.totalGroupMemberships ?? 0).toLocaleString()} participações ativas
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Pontes ActivityPub</span>
                    <Layers className="h-4 w-4 text-primary" />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {isLoadingIntel && !kpis ? (
                      <Skeleton className="h-7 w-16" />
                    ) : (
                      (kpis?.federationEnabledLocalCount ?? 0).toLocaleString()
                    )}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground truncate">
                    Contas locais federando ativamente
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Composição detalhada da Rede: quem é nativo, quem entra via outro provedor e quem interage de fora */}
            <Card className="rounded-2xl border-border/80 bg-card/90">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    Composição da Rede (Origem &amp; Autenticação)
                  </CardTitle>
                  <MetricHint text="Separa exatamente quem criou conta direta no HiperVerso (@usuario@hiperverso.social), quem acessa o site usando outro provedor (Bluesky / Fediverso) e quem interage de servidores externos sem conta aqui." />
                </div>
                <CardDescription className="text-xs">
                  Visão transparente entre contas próprias, logins federados dentro do site e atores externos.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
                <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-1 text-xs font-medium text-muted-foreground">
                    <span>Próprias (@hiperverso.social)</span>
                    <MetricHint text="Contas nativas criadas diretamente no HiperVerso (E-mail ou Google). Mostra quantas ativaram a ponte pública do Fediverso vs. uso apenas local." />
                  </div>
                  <div className="mt-1 text-xl font-bold text-foreground">
                    {(intel?.networkBreakdown?.nativeOwnTotal ?? kpis?.localUsersCount ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.networkBreakdown?.nativeFederatedBridge ?? 0).toLocaleString()} federadas ·{' '}
                    {(intel?.networkBreakdown?.nativeLocalOnly ?? 0).toLocaleString()} só locais
                  </p>
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-1 text-xs font-medium text-muted-foreground">
                    <span>No site · Outro provedor</span>
                    <MetricHint text="Pessoas que navegam e interagem dentro do nosso site usando conta externa (Bluesky/ATProto ou Mastodon/Fediverso)." />
                  </div>
                  <div className="mt-1 text-xl font-bold text-foreground">
                    {(intel?.networkBreakdown?.inSiteOtherProvidersTotal ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.networkBreakdown?.inSiteBluesky ?? 0).toLocaleString()} Bluesky ·{' '}
                    {(intel?.networkBreakdown?.inSiteFediverse ?? 0).toLocaleString()} Fediverso
                  </p>
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-1 text-xs font-medium text-muted-foreground">
                    <span>Fora do site · Interagindo</span>
                    <MetricHint text="Perfis remotos (ap_) de outros servidores (Mastodon, Misskey, etc.) que enviam posts, boosts, curtidas ou seguidores para cá via ActivityPub, sem estarem logados aqui." />
                  </div>
                  <div className="mt-1 text-xl font-bold text-foreground">
                    {(intel?.networkBreakdown?.externalInteractingActors ?? kpis?.federatedActorsCount ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.topFediverseDomains?.length ?? 0).toLocaleString()}+ instâncias externas ativas
                  </p>
                </div>

                <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
                  <div className="flex items-center justify-between gap-1 text-xs font-medium text-muted-foreground">
                    <span>Acessos Hoje (Tempo Real)</span>
                    <MetricHint text="Total de visualizações registradas hoje (sem guardar IP nem dados pessoais), divididas entre contas logadas e visitantes anônimos." />
                  </div>
                  <div className="mt-1 text-xl font-bold text-foreground">
                    {(intel?.accessRealtime?.todayTotal ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.accessRealtime?.todayAuth ?? 0).toLocaleString()} logados ·{' '}
                    {(intel?.accessRealtime?.todayGuests ?? 0).toLocaleString()} visitantes
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Row 1 of Charts: Growth + Posts & Engagements */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    Expansão da Malha ({analyticsRange})
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Novas contas nativas vs. novos perfis do Fediverso descobertos por dia.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-[250px] pr-2">
                  {isLoadingIntel && !intel ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={intel?.timeSeries ?? []}
                        margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis dataKey="date" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis fontSize={11} tickLine={false} axisLine={false} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Area
                          type="monotone"
                          dataKey="newLocalUsers"
                          name="Contas Locais"
                          stroke="hsl(var(--primary))"
                          fill="hsl(var(--primary) / 0.35)"
                        />
                        <Area
                          type="monotone"
                          dataKey="newFederatedActors"
                          name="Atores Federados"
                          stroke="#38bdf8"
                          fill="rgba(56, 189, 248, 0.2)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    Pulso de Publicações &amp; Interações ({analyticsRange})
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Posts nativos, posts federados e soma de engajamentos diários.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-[250px] pr-2">
                  {isLoadingIntel && !intel ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <ComposedChart
                        data={intel?.timeSeries ?? []}
                        margin={{ top: 8, right: 12, left: -16, bottom: 0 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis dataKey="date" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis fontSize={11} tickLine={false} axisLine={false} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar
                          dataKey="newLocalPosts"
                          name="Posts Locais"
                          stackId="posts"
                          fill="hsl(var(--primary))"
                          radius={[2, 2, 0, 0]}
                        />
                        <Bar
                          dataKey="newFederatedPosts"
                          name="Posts Federados"
                          stackId="posts"
                          fill="#38bdf8"
                          radius={[2, 2, 0, 0]}
                        />
                        <Line
                          type="monotone"
                          dataKey="engagements"
                          name="Interações"
                          stroke="#10b981"
                          strokeWidth={2}
                          dot={false}
                        />
                      </ComposedChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Row 2 of Charts: Fediverse Domains + Content Composition */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    Instâncias do Fediverso Conectadas
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Servidores remotos com maior presença de perfis e posts na malha.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-[250px] pr-2">
                  {isLoadingIntel && !intel ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsBarChart
                        data={intel?.topFediverseDomains ?? []}
                        layout="vertical"
                        margin={{ top: 4, right: 16, left: 16, bottom: 4 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis type="number" fontSize={11} />
                        <YAxis
                          dataKey="domain"
                          type="category"
                          width={120}
                          tick={{ fontSize: 11 }}
                          interval={0}
                        />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar dataKey="actorsCount" name="Perfis" fill="hsl(var(--primary))" />
                        <Bar dataKey="postsCount" name="Posts" fill="#38bdf8" />
                      </RechartsBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    Composição de Conteúdo &amp; Comunidades
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Distribuição por formato de publicação e maiores grupos ativos.
                  </CardDescription>
                </CardHeader>
                <CardContent className="h-[250px] flex flex-col justify-between gap-2">
                  {isLoadingIntel && !intel ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <>
                      <div className="h-[155px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <RechartsBarChart
                            data={intel?.contentBreakdown ?? []}
                            layout="vertical"
                            margin={{ top: 0, right: 16, left: 16, bottom: 0 }}
                          >
                            <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                            <XAxis type="number" fontSize={11} />
                            <YAxis
                              dataKey="name"
                              type="category"
                              width={115}
                              tick={{ fontSize: 11 }}
                              interval={0}
                            />
                            <Tooltip />
                            <Bar dataKey="count" name="Total" fill="#10b981" radius={[0, 4, 4, 0]} />
                          </RechartsBarChart>
                        </ResponsiveContainer>
                      </div>
                      {intel?.topGroups && intel.topGroups.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2">
                          <span className="text-[11px] font-semibold text-muted-foreground mr-1">
                            Grupos ativos:
                          </span>
                          {intel.topGroups.map((g) => (
                            <Link
                              key={g.id}
                              href={`/${locale}/messages/group/${g.id}`}
                              className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-foreground hover:border-primary"
                            >
                              <span className="truncate max-w-[140px]">{g.name}</span>
                              <span className="text-primary font-bold">({g.membersCount})</span>
                            </Link>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Top Hashtags Strip */}
            {intel?.topHashtags && intel.topHashtags.length > 0 && (
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="py-3 px-4">
                  <CardTitle className="text-xs sm:text-sm font-bold flex items-center gap-1.5">
                    <Hash className="h-4 w-4 text-primary" />
                    Tópicos e Hashtags de Maior Tração na Rede
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-4 pb-3.5 pt-0 flex flex-wrap gap-1.5">
                  {intel.topHashtags.map((h) => (
                    <Link
                      key={h.tag}
                      href={`/${locale}/tag/${encodeURIComponent(h.tag.replace(/^#+/, ''))}`}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border/80 bg-muted/30 px-3 py-1 text-xs transition-colors hover:border-primary/50 hover:bg-primary/10"
                    >
                      <span className="font-semibold text-foreground">
                        {h.tag.startsWith('#') ? h.tag : `#${h.tag}`}
                      </span>
                      <span className="text-[11px] text-muted-foreground">
                        {h.count} posts · {h.engagements} interações
                      </span>
                    </Link>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Unified Rankings Explorer */}
            <Card className="rounded-2xl border-border/80">
              <CardHeader className="pb-3">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <CardTitle className="text-base font-bold">
                      Rankings Auditados de Conteúdo e Comunidade
                    </CardTitle>
                    <CardDescription className="text-xs">
                      Alterne entre as métricas abaixo para inspecionar posts e membros locais.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { id: 'viewed', label: 'Mais Vistos' },
                      { id: 'liked', label: 'Mais Curtidos' },
                      { id: 'commented', label: 'Mais Comentados' },
                      { id: 'reposted', label: 'Mais Repostados' },
                      { id: 'activeUsers', label: 'Mais Ativos' },
                      { id: 'newUsers', label: `Novas Contas (${kpis?.localUsersCount ?? 0})` },
                    ].map((tabItem) => (
                      <button
                        key={tabItem.id}
                        type="button"
                        onClick={() => setRankingSubTab(tabItem.id as any)}
                        className={cn(
                          'rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                          rankingSubTab === tabItem.id
                            ? 'bg-primary text-primary-foreground'
                            : 'bg-muted/40 text-muted-foreground hover:text-foreground'
                        )}
                      >
                        {tabItem.label}
                      </button>
                    ))}
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {isLoadingIntel && !intel ? (
                  <div className="space-y-2">
                    <Skeleton className="h-12 w-full rounded-xl" />
                    <Skeleton className="h-12 w-full rounded-xl" />
                    <Skeleton className="h-12 w-full rounded-xl" />
                  </div>
                ) : (
                  <div className="divide-y divide-border/50">
                    {(rankingSubTab === 'viewed'
                      ? intel?.rankings.topViewedPosts
                      : rankingSubTab === 'liked'
                      ? intel?.rankings.topLikedPosts
                      : rankingSubTab === 'commented'
                      ? intel?.rankings.topCommentedPosts
                      : rankingSubTab === 'reposted'
                      ? intel?.rankings.topRepostedPosts
                      : null
                    )?.map((post, idx) => (
                      <div
                        key={post.id}
                        className="flex items-center justify-between gap-3 py-2.5 px-2 hover:bg-muted/30 rounded-lg"
                      >
                        <Link
                          href={`/${locale}/post/${post.id}`}
                          target="_blank"
                          className="flex items-center gap-3 min-w-0 flex-1 group"
                        >
                          <span className="text-xs font-mono text-muted-foreground w-5">
                            #{idx + 1}
                          </span>
                          <Avatar className="h-8 w-8 shrink-0">
                            <AvatarImage src={post.authorAvatarUrl} alt={post.authorName} />
                            <AvatarFallback>{post.authorName.slice(0, 1)}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <p className="text-xs sm:text-sm font-semibold text-foreground truncate group-hover:underline">
                              {post.headline || post.text || '(Mídia / Post)'}
                            </p>
                            <p className="text-[11px] text-muted-foreground truncate">
                              por @{post.authorUsername} ·{' '}
                              {new Date(post.createdAt).toLocaleDateString('pt-BR')}
                            </p>
                          </div>
                        </Link>
                        <div className="flex items-center gap-3 text-xs shrink-0">
                          <span className="inline-flex items-center gap-1 text-muted-foreground">
                            <Eye className="h-3.5 w-3.5" /> {post.views.toLocaleString()}
                          </span>
                          <span className="inline-flex items-center gap-1 text-rose-400 font-semibold">
                            <Heart className="h-3.5 w-3.5" /> {post.likes.toLocaleString()}
                          </span>
                          <span className="inline-flex items-center gap-1 text-sky-400">
                            <MessageSquare className="h-3.5 w-3.5" />{' '}
                            {post.commentsCount.toLocaleString()}
                          </span>
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <Repeat2 className="h-3.5 w-3.5" /> {post.reposts.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    ))}

                    {rankingSubTab === 'activeUsers' &&
                      intel?.rankings.mostActiveLocalUsers.map((u, idx) => (
                        <div
                          key={u.id}
                          className="flex items-center justify-between gap-3 py-2.5 px-2 hover:bg-muted/30 rounded-lg"
                        >
                          <Link
                            href={`/${locale}/profile/${u.id}`}
                            target="_blank"
                            className="flex items-center gap-3 min-w-0 flex-1 group"
                          >
                            <span className="text-xs font-mono text-muted-foreground w-5">
                              #{idx + 1}
                            </span>
                            <Avatar className="h-8 w-8 shrink-0">
                              <AvatarImage src={u.avatarUrl} alt={u.name} />
                              <AvatarFallback>{u.name.slice(0, 1)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-xs sm:text-sm font-semibold text-foreground truncate group-hover:underline">
                                {u.name}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                @{u.username}
                              </p>
                            </div>
                          </Link>
                          <div className="flex items-center gap-3 text-xs shrink-0">
                            <span className="font-bold text-foreground">
                              {u.postsCount.toLocaleString()} posts
                            </span>
                            <span className="text-muted-foreground">
                              {u.followersCount.toLocaleString()} seguidores
                            </span>
                          </div>
                        </div>
                      ))}

                    {rankingSubTab === 'newUsers' &&
                      intel?.rankings.recentLocalUsers.map((u) => (
                        <div
                          key={u.id}
                          className="flex items-center justify-between gap-3 py-2.5 px-2 hover:bg-muted/30 rounded-lg"
                        >
                          <Link
                            href={`/${locale}/profile/${u.id}`}
                            target="_blank"
                            className="flex items-center gap-3 min-w-0 flex-1 group"
                          >
                            <Avatar className="h-8 w-8 shrink-0">
                              <AvatarImage src={u.avatarUrl} alt={u.name} />
                              <AvatarFallback>{u.name.slice(0, 1)}</AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <p className="text-xs sm:text-sm font-semibold text-foreground truncate group-hover:underline">
                                {u.name}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                @{u.username}
                              </p>
                            </div>
                          </Link>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground shrink-0">
                            <span>
                              {new Date(u.createdAt).toLocaleString('pt-BR', {
                                dateStyle: 'short',
                                timeStyle: 'short',
                              })}
                            </span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleManageRoles(u as unknown as User)}
                            >
                              Papéis
                            </Button>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TAB 2: GOVERNANCE & SYSTEM CONFIGURATION */}
          <TabsContent value="governance" className="mt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Signup & Slots Control */}
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <UserCheck className="h-4 w-4 text-primary" />
                    Controle de Cadastros &amp; Vagas (_signup/control)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Gerencie em tempo real o limite de vagas iniciais e a proteção de entrada.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="rounded-xl border border-border/70 bg-muted/20 p-3 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">Ocupação das vagas iniciais</span>
                      <span className="font-bold text-foreground">
                        {signupCfg?.used ?? 0} / {signupCfg?.limit ?? 500} (
                        {signupCfg?.open ? 'Aberto' : 'Fechado'})
                      </span>
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{
                          width: `${Math.min(
                            100,
                            ((signupCfg?.used ?? 0) / Math.max(1, signupCfg?.limit ?? 500)) * 100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label htmlFor="signup-limit-input" className="text-xs font-semibold">
                      Limite total de vagas iniciais (0 fecha novos cadastros)
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="signup-limit-input"
                        type="number"
                        min={0}
                        max={1000000}
                        value={signupLimitInput}
                        onChange={(e) => setSignupLimitInput(e.target.value)}
                        className="rounded-xl h-9 text-sm"
                      />
                      <Button
                        size="sm"
                        disabled={isSavingConfig}
                        onClick={() =>
                          void handleSaveSignupConfig({
                            limit: Math.max(0, parseInt(signupLimitInput || '0', 10) || 0),
                          })
                        }
                        className="rounded-xl h-9 px-4"
                      >
                        Salvar limite
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-1.5 pt-1">
                      {[100, 500, 1000, 5000, 10000].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => {
                            setSignupLimitInput(String(preset));
                            void handleSaveSignupConfig({ limit: preset });
                          }}
                          className="rounded-full border border-border/70 bg-muted/30 px-2.5 py-0.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground"
                        >
                          {preset.toLocaleString()} vagas
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Exigir App Check (Anti-Bot no Cadastro)
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Bloqueia criação de contas por scripts fora do navegador oficial.
                      </p>
                    </div>
                    <Switch
                      checked={Boolean(signupCfg?.requireAppCheck)}
                      disabled={isSavingConfig}
                      onCheckedChange={(checked) =>
                        void handleSaveSignupConfig({ requireAppCheck: checked })
                      }
                    />
                  </div>
                </CardContent>
              </Card>

              {/* System & Perimeter Governance */}
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base font-bold flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-400" />
                    Perímetro, P2P &amp; Operação (_system/config)
                  </CardTitle>
                  <CardDescription className="text-xs">
                    Ajustes operacionais da rede, grupos e proteção de perímetro.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Escudo Estrito Anti-Automação &amp; Anti-Pentest
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Bloqueia Nmap, QA não autorizado, Playwright/Headless e raspadores de texto.
                      </p>
                    </div>
                    <Switch
                      checked={sysCfg?.strictAntiBotMode !== false}
                      disabled={isSavingConfig}
                      onCheckedChange={(checked) =>
                        void handleSaveSystemConfig({ strictAntiBotMode: checked })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Prioridade P2P Zero-Banco nas Mensagens
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Conecta aparelhos diretamente via WebRTC + E2EE quando online.
                      </p>
                    </div>
                    <Switch
                      checked={sysCfg?.p2pDefaultEnabled !== false}
                      disabled={isSavingConfig}
                      onCheckedChange={(checked) =>
                        void handleSaveSystemConfig({ p2pDefaultEnabled: checked })
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-border/70 p-3">
                    <div>
                      <p className="text-xs font-semibold text-foreground">
                        Explorar Aberto para Visitantes
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Permite que visitantes naveguem pelos tópicos públicos antes de entrar.
                      </p>
                    </div>
                    <Switch
                      checked={sysCfg?.allowPublicExploreForGuests !== false}
                      disabled={isSavingConfig}
                      onCheckedChange={(checked) =>
                        void handleSaveSystemConfig({ allowPublicExploreForGuests: checked })
                      }
                    />
                  </div>

                  <div className="space-y-1.5 pt-1">
                    <Label htmlFor="max-group-input" className="text-xs font-semibold">
                      Capacidade máxima por grupo (participantes)
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        id="max-group-input"
                        type="number"
                        min={2}
                        max={5000}
                        value={maxGroupInput}
                        onChange={(e) => setMaxGroupInput(e.target.value)}
                        className="rounded-xl h-9 text-sm"
                      />
                      <Button
                        size="sm"
                        disabled={isSavingConfig}
                        onClick={() =>
                          void handleSaveSystemConfig({
                            maxGroupParticipants: Math.max(
                              2,
                              parseInt(maxGroupInput || '1000', 10) || 1000
                            ),
                          })
                        }
                        className="rounded-xl h-9 px-4"
                      >
                        Salvar
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Operational Shortcuts & Privacy Audit Card */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Rss className="h-4 w-4 text-primary" />
                    Ferramentas Editoriais &amp; Portais
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  <Button asChild size="sm" className="rounded-full">
                    <Link href={`/${locale}/admin/trends`}>
                      <Rss className="h-3.5 w-3.5 mr-1.5" />
                      Abrir Trend Hub (RSS)
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="rounded-full">
                    <Link href={`/${locale}/dev`}>
                      <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                      Portal DEV &amp; APK
                    </Link>
                  </Button>
                  <Button asChild size="sm" variant="outline" className="rounded-full">
                    <Link href={`/${locale}/fediverse`}>
                      <Globe className="h-3.5 w-3.5 mr-1.5" />
                      Página do Fediverso
                    </Link>
                  </Button>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-bold flex items-center gap-2">
                    <Lock className="h-4 w-4 text-emerald-400" />
                    Garantias Técnicas de Privacidade Ativas
                  </CardTitle>
                </CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-xl border border-border/60 bg-muted/20 p-2">
                    <p className="font-semibold text-foreground">Egress Guard</p>
                    <p className="text-[11px] text-muted-foreground">Telemetria externa bloqueada</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-muted/20 p-2">
                    <p className="font-semibold text-foreground">TTL de 90 Dias</p>
                    <p className="text-[11px] text-muted-foreground">Marcadores expiram sozinhos</p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* TAB 3: ACCESS & GEOGRAPHY */}
          <TabsContent value="access" className="mt-4 space-y-5">
            {/* Transparência de Coleta, Privacidade & Camada P2P Encriptada */}
            <Card className="rounded-2xl border-primary/25 bg-primary/5">
              <CardContent className="p-3.5 sm:p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2.5">
                  <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    <span>Como os dados são coletados, tratados e protegidos (Zero Rastreamento + P2P E2EE)</span>
                    <MetricHint text="Modelo de telemetria mínima: o IP é usado apenas em memória para estimar cidade/estado e descartado no mesmo milissegundo. Pontos sensíveis (DMs P2P, Cofre de Arquivos, Chaves IDP2P) trafegam criptografados de ponta a ponta sem passar pelo banco." />
                  </div>
                  <Badge variant="outline" className="text-[10px] border-primary/40 text-primary">
                    LGPD · Zero IP Salvo
                  </Badge>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 text-[11px] text-muted-foreground">
                  <div className="rounded-xl border border-border/60 bg-background/60 p-2.5">
                    <div className="flex items-center justify-between font-semibold text-foreground mb-0.5">
                      <span>1. Coleta Mínima</span>
                      <MetricHint text="Registra apenas caminho da página (sem query strings), tipo de público (logado vs. visitante não logado) e região aproximada. Nunca grava cookies de rastreio, fingerprint ou user-agent." />
                    </div>
                    <p>Só rota, público (HiperVerso, não logado ou Fediverso) e região aproximada.</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/60 p-2.5">
                    <div className="flex items-center justify-between font-semibold text-foreground mb-0.5">
                      <span>2. Tratamento & TTL</span>
                      <MetricHint text="O IP é descartado em memória antes de gravar no Firestore. Os eventos brutos são consolidados diariamente em access_agg_daily para contagens reais e rápidas." />
                    </div>
                    <p>IP descartado em memória; consolidação diária anônima sem histórico individual.</p>
                  </div>
                  <div className="rounded-xl border border-border/60 bg-background/60 p-2.5">
                    <div className="flex items-center justify-between font-semibold text-foreground mb-0.5">
                      <span>3. Pontos Sensíveis P2P E2EE</span>
                      <MetricHint text="Mensagens WebRTC P2P, Cofre de Arquivos, Passaporte IDP2P e preferências privadas usam criptografia ponta a ponta no dispositivo: o painel contabiliza totais da rede sem jamais acessar conteúdos." />
                    </div>
                    <p>DMs, Cofre e Chaves IDP2P cifrados no aparelho; painel lê apenas contagens.</p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Resumo de Acessos Diários em Tempo Real */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Online Agora (RTDB)</span>
                    <MetricHint text="Pessoas conectadas neste instante via presença efêmera no Realtime Database, sem armazenar IP ou rastrear navegação individual." />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {((activeUsers ?? 0) + (unauthenticatedActiveUsers ?? 0)).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(activeUsers ?? 0).toLocaleString()} logados · {(unauthenticatedActiveUsers ?? 0).toLocaleString()} visitantes
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Acessos Hoje</span>
                    <MetricHint text="Total acumulado de visualizações de páginas hoje (agregado diário anônimo), comparado ao total de ontem." />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {(intel?.accessRealtime?.todayTotal ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.accessRealtime?.todayAuth ?? 0).toLocaleString()} logados ·{' '}
                    {(intel?.accessRealtime?.todayGuests ?? 0).toLocaleString()} visitantes · ontem:{' '}
                    {(intel?.accessRealtime?.yesterdayTotal ?? 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Média Diária ({analyticsRange})</span>
                    <MetricHint text="Média diária real de acessos considerando apenas os dias do recorte selecionado (7d, 30d ou 90d)." />
                  </div>
                  <div className="mt-1.5 text-2xl font-extrabold text-foreground">
                    {(intel?.accessRealtime?.periodDailyAvg ?? 0).toLocaleString()}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Total no período: {(intel?.accessRealtime?.periodTotal ?? 0).toLocaleString()}
                  </p>
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80 bg-card/90">
                <CardContent className="p-3.5">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Seção Mais Visitada</span>
                    <MetricHint text="Área da rede que concentrou o maior volume de visitas reais no período selecionado." />
                  </div>
                  <div className="mt-1.5 text-lg font-extrabold text-foreground truncate">
                    {intel?.accessRealtime?.sections?.[0]?.section ?? 'Feed Principal'}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {(intel?.accessRealtime?.sections?.[0]?.totalViews ?? 0).toLocaleString()} acessos (
                    {intel?.accessRealtime?.sections?.[0]?.sharePct ?? 0}%)
                  </p>
                </CardContent>
              </Card>
            </div>

            <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-3 rounded-2xl border border-border/80 bg-card/80 p-3.5">
              <RadioGroup
                onValueChange={(v) => setAudienceTypeFilter(v as any)}
                value={audienceTypeFilter}
                className="flex flex-wrap items-center gap-x-4 gap-y-2"
              >
                <Label className="font-semibold text-xs">{t('audienceFilter')}:</Label>
                <div className="flex items-center space-x-1.5">
                  <RadioGroupItem value="all" id="r-all" />
                  <Label htmlFor="r-all" className="text-xs">
                    {t('all')}
                  </Label>
                </div>
                <div className="flex items-center space-x-1.5">
                  <RadioGroupItem value="auth" id="r-auth" />
                  <Label htmlFor="r-auth" className="text-xs">
                    {t('auth')}
                  </Label>
                </div>
                <div className="flex items-center space-x-1.5">
                  <RadioGroupItem value="guest" id="r-guest" />
                  <Label htmlFor="r-guest" className="text-xs">
                    {t('guests')}
                  </Label>
                </div>
              </RadioGroup>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    {t('pageViewsTitle')} ({analyticsRange})
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-[260px] pr-2">
                  {isLoadingPageViews ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart
                        data={pageViews}
                        margin={{ top: 5, right: 12, left: -12, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis dataKey="date" fontSize={11} tickLine={false} axisLine={false} />
                        <YAxis
                          allowDecimals={false}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Area
                          type="monotone"
                          dataKey="auth"
                          name={t('auth')}
                          stackId="1"
                          stroke="hsl(var(--primary))"
                          fill="hsl(var(--primary) / 0.3)"
                        />
                        <Area
                          type="monotone"
                          dataKey="guests"
                          name={t('guests')}
                          stackId="1"
                          stroke="#38bdf8"
                          fill="rgba(56, 189, 248, 0.25)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm sm:text-base font-bold">
                    {t('topRoutesTitle')} ({analyticsRange})
                  </CardTitle>
                </CardHeader>
                <CardContent className="h-[260px] pr-2">
                  {isLoadingTopRoutes ? (
                    <Skeleton className="w-full h-full rounded-xl" />
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <RechartsBarChart
                        data={topRoutesData}
                        layout="vertical"
                        margin={{ top: 5, right: 12, left: 12, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                        <XAxis type="number" fontSize={11} />
                        <YAxis
                          dataKey="path"
                          type="category"
                          width={130}
                          tick={{ fontSize: 11 }}
                          interval={0}
                        />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        <Bar
                          dataKey="authViews"
                          name={t('auth')}
                          stackId="a"
                          fill="hsl(var(--primary))"
                        />
                        <Bar
                          dataKey="guestViews"
                          name={t('guests')}
                          stackId="a"
                          fill="#38bdf8"
                        />
                      </RechartsBarChart>
                    </ResponsiveContainer>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Detalhamento claro por Seção da Rede e Páginas Mais Visitadas */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm sm:text-base font-bold">
                      Acessos por Seção ({analyticsRange})
                    </CardTitle>
                    <MetricHint text="Agrupa todas as visitas reais por área funcional do HiperVerso, separando usuários autenticados e visitantes anônimos." />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2.5">
                  {(intel?.accessRealtime?.sections ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">
                      Sem acessos agregados neste recorte.
                    </p>
                  ) : (
                    intel?.accessRealtime?.sections.map((sec) => (
                      <div key={sec.section} className="space-y-1">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-foreground">{sec.section}</span>
                          <span className="text-muted-foreground">
                            <strong className="text-foreground">{sec.totalViews.toLocaleString()}</strong> ({sec.sharePct}%) ·{' '}
                            {sec.authViews.toLocaleString()} logados · {sec.guestViews.toLocaleString()} visit.
                          </span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${Math.max(4, Math.min(100, sec.sharePct))}%` }}
                          />
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card className="rounded-2xl border-border/80">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2">
                    <CardTitle className="text-sm sm:text-base font-bold">
                      Páginas Mais Visitadas ({analyticsRange})
                    </CardTitle>
                    <MetricHint text="Rotas exatas (sem prefixo de idioma) com maior número de leituras no período, mantendo privacidade total dos visitantes." />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 max-h-[280px] overflow-y-auto pr-1">
                  {(intel?.accessRealtime?.topPages ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground py-4 text-center">
                      Nenhuma página registrada neste recorte.
                    </p>
                  ) : (
                    intel?.accessRealtime?.topPages.map((pg, idx) => (
                      <div
                        key={pg.path}
                        className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-muted/15 px-3 py-2 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-mono font-medium text-foreground truncate">
                            {idx + 1}. {pg.path}
                          </p>
                          <p className="text-[11px] text-muted-foreground">{pg.section}</p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="font-bold text-foreground">{pg.totalViews.toLocaleString()}</p>
                          <p className="text-[10px] text-muted-foreground">
                            {pg.authViews.toLocaleString()} log. / {pg.guestViews.toLocaleString()} vis.
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>
            </div>

            <Card className="rounded-2xl border-border/80">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm sm:text-base font-bold">
                  {t('locationAnalytics')} (Agregado Diário sem IP)
                </CardTitle>
                <div className="flex items-center text-xs text-muted-foreground">
                  <Button
                    variant="link"
                    className="p-0 h-auto text-xs"
                    onClick={() => {
                      setSelectedCountry(null);
                      setSelectedState(null);
                    }}
                  >
                    {t('countries')}
                  </Button>
                  {selectedCountry && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 mx-1" />
                      <Button
                        variant="link"
                        className="p-0 h-auto text-xs"
                        onClick={() => setSelectedState(null)}
                      >
                        {selectedCountry.name}
                      </Button>
                    </>
                  )}
                  {selectedState && (
                    <>
                      <ChevronRight className="h-3.5 w-3.5 mx-1" />
                      <span className="font-semibold text-foreground">{selectedState.name}</span>
                    </>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {!selectedCountry && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {isLoadingCountryViews ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <ResponsiveContainer width="100%" height={340}>
                        <RechartsBarChart
                          data={processedCountryData.data}
                          layout="vertical"
                          margin={{ right: 16 }}
                          onClick={handleCountryClick}
                        >
                          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                          <XAxis type="number" fontSize={11} />
                          <YAxis
                            dataKey="countryName"
                            type="category"
                            width={100}
                            tick={{ fontSize: 11 }}
                            interval={0}
                          />
                          <Tooltip />
                          <Bar
                            dataKey="views"
                            name={audienceFilterMap[audienceTypeFilter].label}
                            fill="hsl(var(--primary))"
                            cursor="pointer"
                          />
                        </RechartsBarChart>
                      </ResponsiveContainer>
                    )}
                    {isLoadingCountryViews ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <GeoAnalyticsTable
                        data={processedCountryData.data}
                        total={processedCountryData.total}
                        locationType="country"
                      />
                    )}
                  </div>
                )}
                {selectedCountry && !selectedState && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {isLoadingTopStates ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <ResponsiveContainer width="100%" height={340}>
                        <RechartsBarChart
                          data={processedStateData.data}
                          layout="vertical"
                          margin={{ right: 16 }}
                          onClick={handleStateClick}
                        >
                          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                          <XAxis type="number" fontSize={11} />
                          <YAxis
                            dataKey="stateName"
                            type="category"
                            width={100}
                            tick={{ fontSize: 11 }}
                            interval={0}
                          />
                          <Tooltip />
                          <Bar
                            dataKey="views"
                            name={audienceFilterMap[audienceTypeFilter].label}
                            fill="#38bdf8"
                            cursor="pointer"
                          />
                        </RechartsBarChart>
                      </ResponsiveContainer>
                    )}
                    {isLoadingTopStates ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <GeoAnalyticsTable
                        data={processedStateData.data}
                        total={processedStateData.total}
                        locationType="state"
                      />
                    )}
                  </div>
                )}
                {selectedState && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {isLoadingTopCities ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <ResponsiveContainer width="100%" height={340}>
                        <RechartsBarChart
                          data={processedCityData.data}
                          layout="vertical"
                          margin={{ right: 16 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" opacity={0.25} />
                          <XAxis type="number" fontSize={11} />
                          <YAxis
                            dataKey="city"
                            type="category"
                            width={100}
                            tick={{ fontSize: 11 }}
                            interval={0}
                          />
                          <Tooltip />
                          <Bar
                            dataKey="views"
                            name={audienceFilterMap[audienceTypeFilter].label}
                            fill="#10b981"
                          />
                        </RechartsBarChart>
                      </ResponsiveContainer>
                    )}
                    {isLoadingTopCities ? (
                      <Skeleton className="h-[340px] w-full rounded-xl" />
                    ) : (
                      <GeoAnalyticsTable
                        data={processedCityData.data}
                        total={processedCityData.total}
                        locationType="city"
                      />
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TAB 4: FEDIVERSE & OFFICIAL ACCOUNT */}
          <TabsContent value="fediverse" className="mt-4 space-y-5">
            <OfficialAccountAdminCard />
            <FediverseAdminPanel />
          </TabsContent>

          {/* TAB 5: USERS & MODERATION */}
          <TabsContent value="usersAndMod" className="mt-4 space-y-5">
            {activeUser?.isAdmin && (
              <>
                <Card className="rounded-2xl border-border/80">
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <CardTitle className="text-base font-bold">Equipe de Administração &amp; Moderação</CardTitle>
                        <CardDescription className="text-xs">
                          Contas com privilégios ativos de administração ou moderação na instância HiperVerso.
                        </CardDescription>
                      </div>
                      <Button variant="outline" size="sm" onClick={() => void loadStaff()} disabled={isLoadingStaff}>
                        {isLoadingStaff ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Atualizar'}
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {isLoadingStaff && staffMembers.length === 0 ? (
                      <div className="space-y-2">
                        <Skeleton className="h-12 w-full rounded-xl" />
                        <Skeleton className="h-12 w-full rounded-xl" />
                      </div>
                    ) : staffMembers.length > 0 ? (
                      <div className="space-y-2 border border-border/70 rounded-xl max-h-80 overflow-y-auto p-2">
                        {staffMembers.map((member) => (
                          <UserListItem
                            key={member.id}
                            userToList={member}
                            activeUserId={activeUser?.id || null}
                            isAdminView={true}
                            onManageRoles={handleManageRoles}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        Nenhum administrador ou moderador listado ainda.
                      </p>
                    )}
                  </CardContent>
                </Card>

                <Card className="rounded-2xl border-border/80">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base font-bold">Atribuir Funções &amp; Buscar Usuários</CardTitle>
                    <CardDescription className="text-xs">
                      Busque qualquer conta local pelo nome ou @username para promover a Moderador ou Administrador.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <form onSubmit={handleUserSearch} className="flex gap-2 mb-4">
                      <Input
                        type="search"
                        placeholder="Busque por nome ou @username..."
                        value={userSearchQuery}
                        onChange={(e) => setUserSearchQuery(e.target.value)}
                        className="rounded-xl"
                      />
                      <Button
                        type="submit"
                        disabled={isSearchingUsers || !userSearchQuery.trim()}
                        className="rounded-xl"
                      >
                        {isSearchingUsers ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <SearchIcon className="mr-2 h-4 w-4" />
                        )}
                        Buscar
                      </Button>
                    </form>
                    {isSearchingUsers ? (
                      <div className="space-y-2">
                        <Skeleton className="h-12 w-full rounded-xl" />
                        <Skeleton className="h-12 w-full rounded-xl" />
                      </div>
                    ) : userSearchResults.length > 0 ? (
                      <div className="space-y-2 border border-border/70 rounded-xl max-h-96 overflow-y-auto p-2">
                        {userSearchResults.map((user) => (
                          <UserListItem
                            key={user.id}
                            userToList={user}
                            activeUserId={activeUser?.id || null}
                            isAdminView={true}
                            onManageRoles={handleManageRoles}
                          />
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground text-center py-4">
                        {userSearchQuery ? 'Nenhum usuário encontrado.' : 'Digite um nome ou @ para buscar.'}
                      </p>
                    )}
                  </CardContent>
                </Card>
              </>
            )}

            <Card className="rounded-2xl border-border/80">
              <CardHeader className="pb-3">
                <CardTitle className="text-base font-bold">
                  Fila de Moderação ({reportedItems.length})
                </CardTitle>
                <CardDescription className="text-xs">
                  Conteúdos sinalizados pela comunidade aguardando revisão.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {isLoadingReports ? (
                  <div className="space-y-3">
                    <Skeleton className="h-32 w-full rounded-xl" />
                  </div>
                ) : reportedItems.length > 0 ? (
                  reportedItems.map((item) => (
                    <ReportedContentCard
                      key={item.reportId}
                      item={item}
                      onIgnore={handleIgnoreReport}
                      onRemove={handleRemoveContent}
                    />
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-6">
                    Nenhum reporte pendente na fila.
                  </p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* TAB 6: PROVENANCE */}
          <TabsContent value="provenance" className="mt-4 space-y-5">
            <ProvenanceAlertsAdminCard />
          </TabsContent>

          {/* TAB 7: HIPERCHAT */}
          <TabsContent value="hiperchat" className="mt-4 space-y-5">
            <HiperChatAdminPanel />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
