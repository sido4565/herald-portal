import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LiveKitRoom, RoomAudioRenderer, VideoConference } from '@livekit/components-react';
import '@livekit/components-styles';

const classId = new URLSearchParams(location.search).get('classId');
const api = async (url, options = {}) => {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
};
const dateLabel = value => value ? new Date(value).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const timeLeft = seconds => `${String(Math.floor(seconds / 3600)).padStart(2, '0')}:${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

function Classroom() {
  const [status, setStatus] = useState(null);
  const [timeOffset, setTimeOffset] = useState(0);
  const [tokenInfo, setTokenInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [connectionMessage, setConnectionMessage] = useState('Connecting to Herald classroom…');
  const [classEnded, setClassEnded] = useState(false);

  const loadStatus = useCallback(async () => {
    const data = await api(`/api/live-classes/${encodeURIComponent(classId)}/status`);
    setStatus(data);
    setTimeOffset(Date.parse(data.server_time) - Date.now());
    return data;
  }, []);

  useEffect(() => {
    if (!classId) { setError('The classroom link is missing its class ID.'); return; }
    let alive = true;
    loadStatus().catch(e => alive && setError(e.message));
    const timer = setInterval(() => loadStatus().catch(() => {}), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [classId, loadStatus]);

  useEffect(() => {
    if (!status?.ends_at) return;
    const update = () => {
      const end = Date.parse(status.ends_at);
      const seconds = Math.max(0, Math.ceil((end - (Date.now() + timeOffset)) / 1000));
      setRemaining(seconds);
      if (seconds === 0 && status.status !== 'COMPLETED') setClassEnded(true);
    };
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [status, timeOffset]);

  const join = async () => {
    setBusy(true); setError('');
    try {
      const info = await api(`/api/live-classes/${encodeURIComponent(classId)}/token`, { method: 'POST', body: '{}' });
      setTokenInfo(info);
      setTimeOffset(Date.parse(info.server_time) - Date.now());
      setStatus(prev => ({ ...prev, ...info.class }));
      setClassEnded(false);
      setConnectionMessage('Joining the classroom…');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const start = async () => {
    setBusy(true); setError('');
    try { await api(`/api/lecturer/live-classes/${encodeURIComponent(classId)}/start`, { method: 'POST', body: '{}' }); await loadStatus(); await join(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const end = async () => {
    if (!confirm('End this class for everyone now?')) return;
    setBusy(true); setError('');
    try {
      await api(`/api/lecturer/live-classes/${encodeURIComponent(classId)}/end`, { method: 'POST', body: '{}' });
      setTokenInfo(null); setConnected(false); setClassEnded(true); await loadStatus();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const lowTime = remaining <= 300;
  const isLecturer = Boolean(status?.is_lecturer);
  const ended = classEnded || status?.status === 'COMPLETED' || status?.status === 'ENDING';
  const inFiveMinutes = remaining > 0 && remaining <= 300;
  const displayTitle = status?.title || 'Live classroom';

  const leaveMessage = useCallback(() => {
    setConnected(false);
    setTokenInfo(null);
    if (Date.now() + timeOffset >= Date.parse(status?.ends_at || 0)) setClassEnded(true);
    else setConnectionMessage('You left the classroom. Rejoin while the class is live.');
  }, [status, timeOffset]);

  return <main className="classroom-shell">
    <header className="classroom-header">
      <a href="dashboard.html" className="classroom-brand">Herald <span>Live Classroom</span></a>
      <div className="classroom-header-actions"><button type="button" onClick={() => history.back()} className="classroom-back">Back to portal</button></div>
    </header>
    <section className="classroom-main">
      <div className="classroom-title-row">
        <div><p className="classroom-eyebrow">{status?.course_title || 'Herald Trainer and Consultant'}</p><h1>{displayTitle}</h1><p className="classroom-lecturer">Lecturer: {status?.lecturer_name || '—'}</p></div>
        <div className={`classroom-countdown ${lowTime ? 'low-time' : ''}`} aria-live="polite"><span>TIME REMAINING</span><strong>{timeLeft(remaining)}</strong><small>{lowTime && !ended ? 'Class ends soon' : ended ? 'Scheduled class ended' : 'Synchronized to Herald server'}</small></div>
      </div>
      <div className="classroom-meta"><span>Starts {dateLabel(status?.scheduled_at)}</span><span>Ends {dateLabel(status?.ends_at)}</span><span>{status?.active_students ?? 0} student{status?.active_students === 1 ? '' : 's'} connected</span></div>
      {error && <div className="classroom-alert" role="alert">{error}</div>}
      {ended ? <div className="classroom-state"><div className="classroom-state-icon">✓</div><h2>This scheduled class has ended</h2><p>Herald saved the attendance for this class. You can close this page or return to your dashboard.</p><a className="classroom-primary" href={isLecturer ? 'lecturer-dashboard.html' : 'dashboard.html'}>Return to dashboard</a></div>
        : tokenInfo ? <div className="classroom-video">
          <div className="classroom-status"><span className={connected ? 'connection-dot connected' : 'connection-dot'}></span>{connected ? 'Connected to live class' : connectionMessage}</div>
          <LiveKitRoom token={tokenInfo.token} serverUrl={tokenInfo.url} connect={true} audio={true} video={true}
            onConnected={() => { setConnected(true); setConnectionMessage('Connected to live class'); }}
            onDisconnected={leaveMessage} onError={e => setError(e.message || 'Could not connect to the classroom.')}>
            <RoomAudioRenderer />
            <VideoConference />
          </LiveKitRoom>
          {isLecturer && <button className="classroom-end" onClick={end} disabled={busy}>End class for everyone</button>}
        </div>
        : <div className="classroom-state">
          <div className="classroom-state-icon">{status?.status === 'LIVE' ? '▶' : '◷'}</div>
          <h2>{status?.status === 'LIVE' ? 'Your classroom is ready' : status?.status === 'COMPLETED' ? 'This class has ended' : 'Waiting for the lecturer to start'}</h2>
          <p>{status?.status === 'LIVE' ? 'Join from inside Herald. Allow microphone and camera access when your browser asks.' : status?.status === 'COMPLETED' ? 'Attendance is saved for this class.' : 'The join button becomes available after the scheduled start and when the lecturer opens the room.'}</p>
          {status?.status === 'LIVE' && <button className="classroom-primary" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join classroom'}</button>}
          {isLecturer && status?.status === 'SCHEDULED' && <button className="classroom-primary" onClick={start} disabled={busy}>{busy ? 'Starting…' : 'Start classroom'}</button>}
          {isLecturer && status?.status === 'LIVE' && <button className="classroom-primary" onClick={join} disabled={busy}>{busy ? 'Joining…' : 'Join classroom'}</button>}
        </div>}
      <p className="classroom-help">If your camera or microphone is unavailable, check the site permissions in your browser and rejoin.</p>
    </section>
  </main>;
}

createRoot(document.getElementById('classroom-root')).render(<Classroom />);
