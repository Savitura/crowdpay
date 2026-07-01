import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateCampaign from './pages/CreateCampaign';
import Campaign from './pages/Campaign';
import CampaignEmbed from './pages/CampaignEmbed';
import Widget from './pages/Widget';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AdminDashboard from './pages/AdminDashboard';
import AcceptInvite from './pages/AcceptInvite';
import Developer from './pages/Developer';
import Dashboard from './pages/Dashboard';
import MyContributions from './pages/MyContributions';
import Profile from './pages/Profile';
import NotFound from './pages/NotFound';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { NetworkStatusProvider } from './context/NetworkStatusContext';
import { OfflineBanner } from './components/OfflineBanner';
import ImpersonationBanner from './components/ImpersonationBanner';
import { useAuth } from './context/AuthContext';

export default function App() {
  const location = useLocation();
  const hideNavbar =
    location.pathname.startsWith('/widget/') || location.pathname.startsWith('/embed/');
  function PrivateRoute({ children }) {
    const { user, ready } = useAuth();
    if (!ready) return null;
    return user ? children : <Navigate to="/login" replace />;
  }

  return (
    <ThemeProvider>
      <AuthProvider>
        <ToastProvider>
          <NetworkStatusProvider>
            <OfflineBanner />
            {!hideNavbar && <ImpersonationBanner />}
            {!hideNavbar && <Navbar />}
            <Routes>
              <Route path="/" element={<Home />} />
              <Route
                path="/campaigns/new"
                element={
                  <PrivateRoute>
                    <CreateCampaign />
                  </PrivateRoute>
                }
              />
              <Route path="/campaigns/:id" element={<Campaign />} />
              <Route path="/campaigns/:id/invite/:token" element={<AcceptInvite />} />
              <Route path="/embed/campaigns/:id" element={<CampaignEmbed />} />
              <Route path="/widget/campaigns/:id" element={<Widget />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route
                path="/admin"
                element={
                  <PrivateRoute>
                    <AdminDashboard />
                  </PrivateRoute>
                }
              />
              <Route
                path="/developer"
                element={
                  <PrivateRoute>
                    <Developer />
                  </PrivateRoute>
                }
              />
              <Route
                path="/dashboard"
                element={
                  <PrivateRoute>
                    <Dashboard />
                  </PrivateRoute>
                }
              />
              <Route
                path="/profile"
                element={
                  <PrivateRoute>
                    <Profile />
                  </PrivateRoute>
                }
              />
              <Route
                path="/my-contributions"
                element={<Navigate to="/dashboard?tab=contributions" replace />}
              />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </NetworkStatusProvider>
        </ToastProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
