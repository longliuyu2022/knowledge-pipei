import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './readability.css';

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <main className="fatal-error"><h1>页面刚刚走神了</h1><p>已经保存的画像和连接仍然保留。刷新后继续探索。</p><button className="button primary" onClick={() => location.reload()}>重新打开</button></main>;
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById('root')!).render(<ErrorBoundary><App/></ErrorBoundary>);
