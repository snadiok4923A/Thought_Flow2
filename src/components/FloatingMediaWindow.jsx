import NodePhotosManager from './NodePhotosManager';
import React, { useState, useRef } from 'react';
import { Upload, X, Move, GripHorizontal, FileImage, ZoomOut, ZoomIn, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';

const FloatingMediaWindow = ({
  activeNode,
  isOpen,
  onClose,
  onUpdateNode,
  processNodeImages,
  onViewPhoto
}) => {
  const [size, setSize] = useState(() => ({
    width: Math.min(460, Math.floor(window.innerWidth * 0.85)),
    height: Math.min(500, Math.floor(window.innerHeight * 0.8))
  }));
  const [position, setPosition] = useState(() => {
    const initialWidth = Math.min(460, Math.floor(window.innerWidth * 0.85));
    return {
      x: Math.max(20, Math.round((window.innerWidth - initialWidth) / 2)),
      y: 76
    };
  });
  const [isMinimized, setIsMinimized] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);

  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const resizeStartRef = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 });

  // Smooth Dragging
  const handleDragStart = (e) => {
    if (e.target.closest('button, input, textarea, a, .no-drag')) return;
    e.preventDefault();
    dragOffsetRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y
    };
    setIsDragging(true);

    const onMouseMove = (moveEvent) => {
      const maxX = Math.max(10, window.innerWidth - size.width - 10);
      const maxY = Math.max(10, window.innerHeight - (isMinimized ? 48 : size.height) - 10);
      const nextX = Math.max(10, Math.min(maxX, moveEvent.clientX - dragOffsetRef.current.x));
      const nextY = Math.max(10, Math.min(maxY, moveEvent.clientY - dragOffsetRef.current.y));
      setPosition({ x: nextX, y: nextY });
    };

    const onMouseUp = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  // Smooth Corner / Edge Resizing
  const handleResizeStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: size.width,
      startHeight: size.height
    };
    setIsResizing(true);

    const onMouseMove = (moveEvent) => {
      const deltaX = moveEvent.clientX - resizeStartRef.current.startX;
      const deltaY = moveEvent.clientY - resizeStartRef.current.startY;
      
      const newWidth = Math.max(420, Math.min(window.innerWidth * 0.75, resizeStartRef.current.startWidth + deltaX));
      const newHeight = Math.max(380, Math.min(window.innerHeight * 0.85, resizeStartRef.current.startHeight + deltaY));
      
      setSize({ width: newWidth, height: newHeight });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  const handleIncreaseSize = () => {
    setSize(prev => ({
      width: Math.min(window.innerWidth * 0.75, prev.width + 50),
      height: Math.min(window.innerHeight * 0.85, prev.height + 50)
    }));
  };

  const handleDecreaseSize = () => {
    setSize(prev => ({
      width: Math.max(420, prev.width - 50),
      height: Math.max(380, prev.height - 50)
    }));
  };

  const handleResetSize = () => {
    setSize({
      width: Math.min(460, Math.floor(window.innerWidth * 0.85)),
      height: Math.min(500, Math.floor(window.innerHeight * 0.8))
    });
  };

  if (!activeNode) return null;

  return (
    <>
      {/* Full-screen mask during drag/resize for buttery smooth motion */}
      {isOpen && (isDragging || isResizing) && (
        <div className="fixed inset-0 z-[10001] bg-transparent select-none cursor-move pointer-events-auto" />
      )}

      <div
        style={{
          position: 'fixed',
          left: `${position.x}px`,
          top: `${position.y}px`,
          width: `${size.width}px`,
          height: isMinimized ? 'auto' : `${size.height}px`,
          zIndex: 9990,
          display: isOpen ? 'flex' : 'none'
        }}
        className="floating-media-window flex flex-col bg-[#0c0c0e]/95 backdrop-blur-2xl border border-zinc-700/80 rounded-2xl shadow-[0_25px_60px_rgba(0,0,0,0.85)] ring-1 ring-purple-500/30 overflow-hidden select-none animate-in fade-in zoom-in-95 duration-200 transition-[box-shadow]"
      >
        {/* Draggable Header */}
        <div
          onMouseDown={handleDragStart}
          className="flex items-center justify-between px-3.5 py-2.5 bg-zinc-900/90 border-b border-zinc-800 cursor-grab active:cursor-grabbing text-zinc-300"
          title="Hold & drag to move this floating photos window anywhere"
        >
          <div className="flex items-center space-x-2 overflow-hidden mr-2">
            <GripHorizontal className="w-4 h-4 text-zinc-500 hover:text-purple-400 transition-colors flex-shrink-0" />
            <span className="text-xs font-semibold text-white truncate max-w-[150px]">
              {activeNode.text || 'Untitled Node'}
            </span>
            <span className="text-[10px] text-purple-400 font-mono px-1.5 py-0.5 bg-purple-500/10 rounded border border-purple-500/20 flex-shrink-0 flex items-center space-x-1">
              <FileImage className="w-3 h-3" />
              <span>Photos</span>
              {activeNode.images && activeNode.images.length > 0 && (
                <span className="px-1 py-0.2 rounded-full text-[9px] font-mono bg-purple-500/30 text-purple-200 ml-0.5">
                  {activeNode.images.length}
                </span>
              )}
            </span>
          </div>

          {/* Window Action Buttons (Size / Minimize / Close) */}
          <div className="flex items-center space-x-1 no-drag flex-shrink-0">
            <button
              type="button"
              onClick={handleDecreaseSize}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors cursor-pointer"
              title="Decrease window size"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleIncreaseSize}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors cursor-pointer"
              title="Increase window size"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={handleResetSize}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors cursor-pointer"
              title="Reset window size"
            >
              <RotateCcw className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setIsMinimized(!isMinimized)}
              className="p-1 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded transition-colors cursor-pointer"
              title={isMinimized ? "Expand window" : "Minimize window"}
            >
              {isMinimized ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded transition-colors cursor-pointer"
              title="Close floating photos window"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Content Body */}
        {!isMinimized && (
          <div className="flex-grow p-3 overflow-hidden flex flex-col relative bg-zinc-950/40">
            <div className="w-full h-full flex flex-col">
              <NodePhotosManager
                key={`float-photos-${activeNode.id}`}
                images={activeNode.images || []}
                onAddImages={(files) => processNodeImages(files, activeNode)}
                onDeleteImage={(imageId) => {
                  const remaining = (activeNode.images || []).filter(img => img.id !== imageId);
                  onUpdateNode({ images: remaining });
                }}
                onViewPhoto={onViewPhoto}
              />
            </div>

            {/* Corner Resize Drag Handle */}
            <div
              onMouseDown={handleResizeStart}
              className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize hover:bg-purple-500/30 transition-colors z-20 flex items-center justify-center group"
              title="Drag corner to smoothly resize window"
            >
              <div className="w-2 h-2 border-r-2 border-b-2 border-zinc-500 group-hover:border-purple-400 transition-colors" />
            </div>
          </div>
        )}
      </div>
    </>
  );
};


export default FloatingMediaWindow;
