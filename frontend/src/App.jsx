import React from 'react';
import { Routes, Route } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateCampaign from './pages/CreateCampaign';
import Campaign from './pages/Campaign';
import CampaignEmbed from './pages/CampaignEmbed';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AdminDashboard from './pages/AdminDashboard';
import AcceptInvite from './pages/AcceptInvite';
import Developer from './pages/Developer';
import Dashboard from './pages/Dashboard';
import MyContributions from './pages/MyContributions';
import NotFound from './pages/NotFound';
import { AuthProvider } from './context/AuthContext';

export default function App() {
  return (
    <AuthProvider>
      <Navbar />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/campaigns/new" element={<CreateCampaign />} />
        <Route path="/campaigns/:id" element={<Campaign />} />
        <Route path="/campaigns/:id/invite/:token" element={<AcceptInvite />} />
        <Route path="/embed/campaigns/:id" element={<CampaignEmbed />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/developer" element={<Developer />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/my-contributions" element={<MyContributions />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </AuthProvider>
  );
}
