import React, { useState } from 'react';
import {
  Lock,
  Mail,
  User as UserIcon,
  Eye,
  EyeOff,
  Sparkles,
  AlertCircle,
  ArrowRight,
  ShieldCheck,
  Zap,
  Terminal,
  KeyRound
} from 'lucide-react';
import { authAPI } from '../services/api';
import { User } from '../types';

interface AuthScreenProps {
  onAuthSuccess: (user: User, token: string) => void;
}

export const AuthScreen: React.FC<AuthScreenProps> = ({ onAuthSuccess }) => {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');

  // Form Fields
  const [emailOrUsername, setEmailOrUsername] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Status & Feedback
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Quick fill presentation credentials (1-click fast judge testing)
  const handleQuickFillDemo = async () => {
    setMode('signin');
    const demoEmail = 'admin@devcollab.io';
    const demoPassword = 'Password@123';
    setEmailOrUsername(demoEmail);
    setPassword(demoPassword);
    setError(null);
    setLoading(true);
    try {
      const { token, user } = await authAPI.login(demoEmail, demoPassword);
      onAuthSuccess(user, token);
    } catch (err: any) {
      const message = err.response?.data?.error || err.response?.data?.message || err.message || 'Quick fill authentication failed';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === 'signin') {
      if (!emailOrUsername.trim()) {
        setError('Please enter your email or username.');
        return;
      }
      if (!password) {
        setError('Please enter your password.');
        return;
      }

      setLoading(true);
      try {
        const { token, user } = await authAPI.login(emailOrUsername.trim(), password);
        onAuthSuccess(user, token);
      } catch (err: any) {
        const message = err.response?.data?.error || err.response?.data?.message || err.message || 'Invalid credentials';
        setError(message);
      } finally {
        setLoading(false);
      }
    } else {
      // Sign Up Validations
      if (!username.trim() || username.trim().length < 2) {
        setError('Username must be at least 2 characters long.');
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email.trim() || !emailRegex.test(email.trim())) {
        setError('Please enter a valid email address.');
        return;
      }

      if (!password || password.length < 6) {
        setError('Password must be at least 6 characters long.');
        return;
      }

      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }

      setLoading(true);
      try {
        const { token, user } = await authAPI.register(
          username.trim(),
          email.trim(),
          password
        );
        onAuthSuccess(user, token);
      } catch (err: any) {
        const message = err.response?.data?.error || err.response?.data?.message || err.message || 'Registration failed';
        setError(message);
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-screen w-full bg-[#090D16] text-slate-200 flex flex-col justify-center items-center p-4 relative overflow-hidden font-sans select-none">
      {/* Background Cyber Glow & Grid Accents */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[350px] bg-gradient-to-tr from-cyan-500/10 via-indigo-600/10 to-violet-500/10 blur-[130px] pointer-events-none rounded-full" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(0,240,255,0.03)_0,transparent_70%)] pointer-events-none" />

      {/* Main Glassmorphic Container */}
      <div className="w-full max-w-md relative z-10">
        {/* Brand Banner */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-br from-cyan-400 to-indigo-600 p-0.5 shadow-lg shadow-cyan-500/20 mb-3">
            <div className="h-full w-full bg-[#090D16] rounded-[10px] flex items-center justify-center">
              <Terminal className="h-6 w-6 text-cyan-400" />
            </div>
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white flex items-center justify-center space-x-2">
            <span>DevCollab</span>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/30 text-cyan-400 font-semibold tracking-wide">
              ZERO-TRUST GATE
            </span>
          </h1>
          <p className="text-xs text-slate-400 mt-1 max-w-xs mx-auto">
            Decentralized CRDT collaborative engineering with PBKDF2 authenticated workspace isolation.
          </p>
        </div>

        {/* Glass Card */}
        <div className="rounded-2xl border border-[#1E293B] bg-[#0F1624]/90 backdrop-blur-xl p-6 sm:p-7 shadow-[0_20px_50px_rgba(0,0,0,0.8)] ring-1 ring-white/5">
          {/* Quick Demo Fill Pill (Judge Presentation Shortcut) */}
          <div className="mb-5 p-2.5 rounded-xl border border-cyan-500/30 bg-cyan-950/20 flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2 text-cyan-300">
              <Zap className="h-4 w-4 text-cyan-400 animate-pulse flex-shrink-0" />
              <div className="min-w-0">
                <span className="font-semibold block text-[11px] leading-tight text-slate-200">Demo Presentation Access</span>
                <span className="text-[10px] text-cyan-400/80 font-mono">admin@devcollab.io</span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleQuickFillDemo}
              disabled={loading}
              className="px-2.5 py-1 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-[11px] transition-colors shadow-sm flex items-center space-x-1 disabled:opacity-50"
            >
              <Sparkles className="h-3 w-3" />
              <span>{loading ? 'Entering...' : 'Quick Fill Demo Account'}</span>
            </button>
          </div>

          {/* Tab Selector */}
          <div className="grid grid-cols-2 p-1 rounded-xl bg-[#090D16] border border-[#1E293B] mb-5 text-xs font-semibold">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError(null);
              }}
              className={`py-2 rounded-lg transition-all text-center ${
                mode === 'signin'
                  ? 'bg-[#15233E] text-cyan-300 shadow-sm border border-cyan-500/30 font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError(null);
              }}
              className={`py-2 rounded-lg transition-all text-center ${
                mode === 'signup'
                  ? 'bg-[#15233E] text-cyan-300 shadow-sm border border-cyan-500/30 font-bold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* Error Banner */}
          {error && (
            <div className="mb-4 p-3 rounded-xl border border-rose-500/40 bg-rose-950/40 text-rose-200 text-xs flex items-start space-x-2.5 animate-in fade-in duration-200">
              <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
              <span className="leading-relaxed">{error}</span>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'signup' ? (
              <>
                {/* Username */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Username
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <UserIcon className="h-4 w-4" />
                    </div>
                    <input
                      type="text"
                      required
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="e.g. quantum_coder"
                      className="w-full bg-[#090D16] border border-[#253554] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
                    />
                  </div>
                </div>

                {/* Email */}
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1.5">
                    Email Address
                  </label>
                  <div className="relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                      <Mail className="h-4 w-4" />
                    </div>
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="engineer@devcollab.io"
                      className="w-full bg-[#090D16] border border-[#253554] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
                    />
                  </div>
                </div>
              </>
            ) : (
              /* Sign In Identifier */
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Email or Username
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <Mail className="h-4 w-4" />
                  </div>
                  <input
                    type="text"
                    required
                    value={emailOrUsername}
                    onChange={(e) => setEmailOrUsername(e.target.value)}
                    placeholder="admin@devcollab.io"
                    className="w-full bg-[#090D16] border border-[#253554] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
                  />
                </div>
              </div>
            )}

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password {mode === 'signup' && <span className="text-slate-500">(min. 6 characters)</span>}
              </label>
              <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Lock className="h-4 w-4" />
                </div>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-[#090D16] border border-[#253554] rounded-lg pl-9 pr-10 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {/* Confirm Password (Sign Up Only) */}
            {mode === 'signup' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <KeyRound className="h-4 w-4" />
                  </div>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full bg-[#090D16] border border-[#253554] rounded-lg pl-9 pr-3 py-2 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400 transition"
                  />
                </div>
              </div>
            )}

            {/* Submit CTA */}
            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 py-2.5 rounded-lg bg-gradient-to-r from-cyan-400 to-indigo-500 hover:from-cyan-300 hover:to-indigo-400 text-slate-950 font-bold text-xs uppercase tracking-wider transition-all shadow-lg shadow-cyan-500/20 active:scale-[0.99] disabled:opacity-50 flex items-center justify-center space-x-2"
            >
              {loading ? (
                <div className="h-4 w-4 border-2 border-slate-950 border-t-transparent rounded-full animate-spin" />
              ) : (
                <>
                  <span>{mode === 'signin' ? 'Sign In to Workspace' : 'Initialize Account'}</span>
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>

          {/* Footer Security Badges */}
          <div className="mt-6 pt-4 border-t border-[#1E293B] flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center space-x-1.5 text-slate-400">
              <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
              <span>PBKDF2-SHA512 + HMAC</span>
            </span>
            <span className="font-mono text-[10px] text-slate-500">SQLite RBAC Gated</span>
          </div>
        </div>
      </div>
    </div>
  );
};
