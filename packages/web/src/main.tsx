// 저장된 테마를 첫 페인트 전에 적용해 플래시를 막는다.
try { const t = localStorage.getItem('ttym-theme'); if (t === 'light') document.documentElement.dataset.theme = 'light'; } catch {}
import { createRoot } from 'react-dom/client';
import App from './App';
import './theme.css';

createRoot(document.getElementById('root')!).render(<App />);
