import React from 'react';
import { Layers } from 'lucide-react';

interface HeaderProps {
  isFullscreen: boolean;
  fullscreenTransitioning: boolean;
  onReset: () => void;
}

const Header: React.FC<HeaderProps> = ({ isFullscreen, fullscreenTransitioning, onReset }) => {
  return (
      <div className={`bg-neutral-950 border-b border-neutral-800 flex items-center px-4 gap-4 shrink-0 overflow-hidden transition-all duration-300 ease-in-out ${isFullscreen || fullscreenTransitioning ? 'h-0 opacity-0 border-b-0' : 'h-10 opacity-100'}`}>
        <button
          onClick={onReset}
          className="text-sm font-bold flex items-center gap-2 hover:text-orange-300 transition-colors"
          title="初期画面に戻る"
        >
          <Layers size={18} className="text-orange-400" />
          漫画差分検出
        </button>
        <div className="flex-1" />
        <span className="text-xs px-2 py-0.5 rounded bg-green-900/50 text-green-300">
          Ready
        </span>
      </div>
  );
};

export default Header;
