import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { useEffect } from "react";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Navbar } from "@/components/Navbar";
import { useAstroWebSocket } from "@/hooks/useAstroWebSocket";
import { ScienceModeProvider } from "@/lib/ScienceModeContext";
import { ThemeProvider } from "@/lib/ThemeContext";
import { AuthProvider } from "@/lib/AuthContext";
import { NotificationsProvider, useNotifications } from "@/lib/NotificationsContext";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import EventsPage from "@/pages/events";
import EventDetailPage from "@/pages/event-detail";
import LoginPage from "@/pages/login";
import TeamPage from "@/pages/team";
import ResearchWorkspacePage from "@/pages/research-workspace";
import BookmarksPage from "@/pages/bookmarks";
import WebSocketDebug from "@/pages/websocket-debug";
import SettingsPage from "@/pages/settings";
import CircularDetailPage from "@/pages/circular-detail";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ProtectedRoute } from "@/components/ProtectedRoute";

const queryClient = new QueryClient();

function Router() {
  const { isConnected, listenerAlive, gaveUp, retryCount, latestNotification } = useAstroWebSocket();
  const { addNotification } = useNotifications();

  // Forward WS notifications into context
  useEffect(() => {
    if (latestNotification) {
      addNotification(latestNotification);
    }
  }, [latestNotification]);

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      <Navbar
        isConnected={isConnected}
        listenerAlive={listenerAlive}
        gaveUp={gaveUp}
        retryCount={retryCount}
      />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Switch>
          <Route path="/">
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          </Route>
          <Route path="/events">
            <ProtectedRoute>
              <EventsPage />
            </ProtectedRoute>
          </Route>
          <Route path="/events/:id/workspace">
            <ProtectedRoute>
              <ResearchWorkspacePage />
            </ProtectedRoute>
          </Route>
          <Route path="/events/:id">
            <ProtectedRoute>
              <EventDetailPage />
            </ProtectedRoute>
          </Route>
          <Route path="/bookmarks">
            <ProtectedRoute>
              <BookmarksPage />
            </ProtectedRoute>
          </Route>
          <Route path="/login" component={LoginPage} />
          <Route path="/team">
            <ProtectedRoute>
              <TeamPage />
            </ProtectedRoute>
          </Route>
          <Route path="/settings">
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          </Route>
          {/* A circular is normally read on its event's page, but 43,166 of the
              44,766 here are attached to no event, so they need a home of their
              own. Search linked here before this route existed and hit 404. */}
          <Route path="/circulars/:circularId">
            <ProtectedRoute>
              <CircularDetailPage />
            </ProtectedRoute>
          </Route>
          <Route path="/debug/ws" component={WebSocketDebug} />
          <Route component={NotFound} />
        </Switch>
      </main>
    </div>
  );
}

function App() {
  const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID || "dummy-client-id.apps.googleusercontent.com";
  return (
    <ErrorBoundary>
      <GoogleOAuthProvider clientId={googleClientId}>
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <AuthProvider>
              <ThemeProvider>
                <ScienceModeProvider>
                  <NotificationsProvider>
                    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
                      <Router />
                    </WouterRouter>
                    <Toaster />
                  </NotificationsProvider>
                </ScienceModeProvider>
              </ThemeProvider>
            </AuthProvider>
          </TooltipProvider>
        </QueryClientProvider>
      </GoogleOAuthProvider>
    </ErrorBoundary>
  );
}

export default App;
