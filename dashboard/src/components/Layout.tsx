import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  LayoutDashboard,
  Smartphone,
  FileText,
  LogOut,
  Sun,
  Moon,
  Monitor,
  Menu,
  X,
  ChevronLeft,
  ChevronRight,
  Languages,
  Inbox,
  Users,
  Workflow,
  Zap,
  Megaphone,
  BarChart3,
  UserCog,
  Settings,
} from 'lucide-react';
import { Logo } from './Logo';
import { useTheme } from '../hooks/useTheme';
import { type UserRole } from '../hooks/useRole';
import { languageOptions, resolveSupportedLanguage, rtlLanguages, type SupportedLanguage } from '../i18n';
import { healthApi } from '../services/api';
import './Layout.css';

interface LayoutProps {
  onLogout: () => void;
  userRole: UserRole | null;
}

/**
 * Sidebar navigation.
 *
 * Two kinds of entry live here. Items with a `key` are the inherited gateway pages and are labelled
 * through i18n, which has all 13 locales. Items with a `label` are the command-center surfaces,
 * whose page content is English-only for now — labelling their nav entry in Spanish while the page
 * behind it is English would be worse than being consistently English, and inventing translations
 * to satisfy the parity check would be worse still. They are marked `section` so the sidebar can
 * group them.
 */
type NavEntry = {
  to: string;
  icon: typeof LayoutDashboard;
  adminOnly: boolean;
  section: 'workspace' | 'configure';
} & { label: string; key?: never };

const allNavItems: NavEntry[] = [
  // ── The daily work. Nothing here is optional and nothing duplicates anything else. ──
  { to: '/', icon: LayoutDashboard, label: 'Overview', adminOnly: false, section: 'workspace' },
  { to: '/inbox', icon: Inbox, label: 'Inbox', adminOnly: false, section: 'workspace' },
  { to: '/contacts', icon: Users, label: 'Contacts', adminOnly: false, section: 'workspace' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics', adminOnly: false, section: 'workspace' },

  // ── Set up once, revisit occasionally. ──
  { to: '/automations', icon: Workflow, label: 'Automations', adminOnly: false, section: 'configure' },
  { to: '/quick-replies', icon: Zap, label: 'Quick Replies', adminOnly: false, section: 'configure' },
  { to: '/broadcasts', icon: Megaphone, label: 'Broadcasts', adminOnly: false, section: 'configure' },
  { to: '/numbers', icon: Smartphone, label: 'Numbers', adminOnly: false, section: 'configure' },
  { to: '/document-delivery', icon: FileText, label: 'Document Delivery', adminOnly: false, section: 'configure' },
  { to: '/team', icon: UserCog, label: 'Team', adminOnly: false, section: 'configure' },
  { to: '/settings', icon: Settings, label: 'Settings', adminOnly: false, section: 'configure' },
];

/**
 * Destinations that are still routed and still work, but no longer earn a permanent sidebar row.
 *
 * `Chats` and `Sessions` are the gateway's own versions of Inbox and Numbers — keeping both in the
 * nav meant every operator faced two doors to the same room and had to learn which was which. The
 * rest (Templates, Message Tester, Logs, and the admin surfaces) are occasional tools, not daily
 * work. Settings links to all of them, so nothing is lost — the sidebar simply stops implying they
 * are as important as the Inbox.
 */
const SECTION_LABELS: Record<NavEntry['section'], string> = {
  workspace: 'Workspace',
  configure: 'Manage',
};

const themeIcons = { light: Sun, dark: Moon, system: Monitor };

export function Layout({ onLogout, userRole }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const ThemeIcon = themeIcons[theme];
  const themeLabel = t(`theme.${theme}`);

  const navItems = allNavItems.filter(item => !item.adminOnly || userRole === 'admin');

  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);
  // Show the build-time version immediately, then replace it with the live running version from the
  // backend so a stale-built bundle can't display the wrong number. Falls back silently on error.
  const [version, setVersion] = useState(__APP_VERSION__);
  const [isLanguageMenuOpen, setIsLanguageMenuOpen] = useState(false);
  const languageMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (!mobile) setIsMobileOpen(false);
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    let active = true;
    healthApi
      .check()
      .then(info => {
        if (active && info?.version) setVersion(info.version);
      })
      .catch(() => {
        /* keep the build-time fallback */
      });
    return () => {
      active = false;
    };
  }, []);

  const handleNavClick = () => {
    if (isMobile) setIsMobileOpen(false);
  };

  useEffect(() => {
    document.body.style.overflow = isMobileOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isMobileOpen]);

  useEffect(() => {
    if (!isLanguageMenuOpen) return;

    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setIsLanguageMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsLanguageMenuOpen(false);
    };

    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isLanguageMenuOpen]);

  const toggleCollapse = () => setIsCollapsed(!isCollapsed);
  const toggleMobile = () => setIsMobileOpen(!isMobileOpen);

  const currentLang = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
  const languageLabel = languageOptions.find(option => option.value === currentLang)?.compactLabel ?? 'EN';
  const changeLanguage = (language: SupportedLanguage) => {
    setIsLanguageMenuOpen(false);
    void i18n.changeLanguage(language);
  };
  const isRtl = rtlLanguages.includes(currentLang);

  return (
    <div className="layout">
      {isMobile && (
        <header className="mobile-header">
          <button className="mobile-menu-btn" onClick={toggleMobile} aria-label={t('common.expand')}>
            {isMobileOpen ? <X size={24} /> : <Menu size={24} />}
          </button>
          <div className="mobile-brand">
            <Logo size={28} className="sidebar-logo" />
            <span className="brand-name">{t('common.appName')}</span>
          </div>
          <div style={{ width: 40 }} />
        </header>
      )}

      {isMobile && isMobileOpen && <div className="sidebar-overlay" onClick={() => setIsMobileOpen(false)} />}

      <aside
        className={`sidebar ${isCollapsed ? 'collapsed' : ''} ${isMobile ? 'mobile' : ''} ${isMobileOpen ? 'open' : ''}`}
      >
        <div className="sidebar-header">
          <Logo size={28} className="sidebar-logo" />
          {!isCollapsed && (
            <div className="sidebar-brand">
              <span className="brand-name">{t('common.appName')}</span>
              <span className="brand-version">v{version}</span>
            </div>
          )}
        </div>

        {!isMobile && (
          <button
            className="collapse-toggle"
            onClick={toggleCollapse}
            title={isCollapsed ? t('common.expand') : t('common.collapse')}
            aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
          >
            {isCollapsed ? (
              isRtl ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )
            ) : isRtl ? (
              <ChevronRight size={16} />
            ) : (
              <ChevronLeft size={16} />
            )}
          </button>
        )}

        <nav className="sidebar-nav">
          {(['workspace', 'configure'] as const).map(section => {
            const items = navItems.filter(item => item.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section} className="nav-section">
                {!isCollapsed && <p className="nav-section-label">{SECTION_LABELS[section]}</p>}
                {items.map(item => {
                  const { to, icon: Icon } = item;
                  const label = item.label;
                  return (
                    <NavLink
                      key={`${section}-${to}`}
                      to={to}
                      className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                      end={to === '/'}
                      onClick={handleNavClick}
                      title={isCollapsed ? label : undefined}
                    >
                      <Icon size={20} />
                      {!isCollapsed && <span>{label}</span>}
                    </NavLink>
                  );
                })}
              </div>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <div className="language-menu" ref={languageMenuRef}>
            <button
              className="theme-toggle-btn"
              onClick={() => setIsLanguageMenuOpen(open => !open)}
              title={t('common.language')}
              aria-label={t('common.language')}
              aria-haspopup="menu"
              aria-expanded={isLanguageMenuOpen}
            >
              <Languages size={18} />
              {!isCollapsed && <span>{languageLabel}</span>}
            </button>
            {isLanguageMenuOpen && (
              <div className="language-menu-list" role="menu" aria-label={t('common.language')}>
                {languageOptions.map(option => (
                  <button
                    key={option.value}
                    className={`language-menu-item ${option.value === currentLang ? 'active' : ''}`}
                    onClick={() => changeLanguage(option.value)}
                    role="menuitemradio"
                    aria-checked={option.value === currentLang}
                  >
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="appearance-menu">
            <button
              className="theme-toggle-btn"
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              title={t('theme.toggleTo', { value: t(resolvedTheme === 'dark' ? 'theme.light' : 'theme.dark') })}
              aria-label={t('theme.toggleTo', { value: t(resolvedTheme === 'dark' ? 'theme.light' : 'theme.dark') })}
            >
              <span className="appearance-button-cue" aria-hidden="true">
                <ThemeIcon size={16} />
              </span>
              {!isCollapsed && <span>{themeLabel}</span>}
            </button>
          </div>
          <button className="logout-btn" onClick={onLogout} title={isCollapsed ? t('common.logout') : undefined}>
            <LogOut size={20} />
            {!isCollapsed && <span>{t('common.logout')}</span>}
          </button>
        </div>
      </aside>

      <main className={`main-content ${isCollapsed ? 'expanded' : ''} ${isMobile ? 'mobile' : ''}`}>
        <Outlet />
      </main>
    </div>
  );
}
