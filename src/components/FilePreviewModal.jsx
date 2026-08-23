import React, { useState, useEffect, useRef } from 'react';
import { X, ExternalLink, Download, FileText, Image as ImageIcon, Link, Search, SearchX, Upload, Play, Loader2, Pause, Volume2, VolumeX, Maximize2, Minimize2, FileImage, FileCode, ClipboardPaste, RotateCcw, Check, Copy, ZoomOut, ZoomIn, ChevronLeft, ChevronRight, Trash2 } from 'lucide-react';
import PdfViewer from './PdfViewer';
import { readClipboardAsFiles } from '../utils/fileUtils';

const FilePreviewModal = ({ 
  file, 
  allFiles, 
  onClose, 
  onSelectFile, 
  previewWidth, 
  setPreviewWidth, 
  sidebarWidth = 384, 
  isSidebarOpen = false,
  getFileViewState,
  saveFileViewState,
  onDeleteFile,
  onPasteFiles,
  activeSection,
  onSelectSection,
  isDragTarget = false
}) => {
  const [contentZoom, setContentZoom] = useState(() => (getFileViewState ? getFileViewState(file?.id)?.zoom || 1 : 1));
  const [isResizing, setIsResizing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [contextMenu, setContextMenu] = useState(null); // { x, y }
  const textContainerRef = useRef(null);
  const imageContainerRef = useRef(null);

  // Sync zoom state with file view state
  const handleZoomUpdate = (newZoom) => {
    setContentZoom(newZoom);
    if (saveFileViewState && file?.id) {
      saveFileViewState(file.id, { zoom: newZoom });
    }
  };

  // Close context menu on outside click
  useEffect(() => {
    const handleClick = () => setContextMenu(null);
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  // Restore scroll positions on file change
  useEffect(() => {
    const saved = getFileViewState ? getFileViewState(file?.id) : {};
    if (textContainerRef.current && saved?.textScrollTop !== undefined) {
      textContainerRef.current.scrollTop = saved.textScrollTop;
    }
    if (imageContainerRef.current) {
      if (saved?.imageScrollTop !== undefined) imageContainerRef.current.scrollTop = saved.imageScrollTop;
      if (saved?.imageScrollLeft !== undefined) imageContainerRef.current.scrollLeft = saved.imageScrollLeft;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id]);

  // Copy text content to clipboard
  const handleCopyText = async () => {
    if (!file?.textContent) return;
    try {
      await navigator.clipboard.writeText(file.textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  // Paste screenshot / image / text from clipboard
  const handlePasteClipboard = async () => {
    setContextMenu(null);
    try {
      const files = await readClipboardAsFiles();
      if (files && files.length > 0) {
        if (onPasteFiles) onPasteFiles(files);
      } else {
        alert('Clipboard is empty. Copy some text or capture a screenshot (Win+Shift+S or PrtScn) and press Ctrl+V to paste!');
      }
    } catch {
      alert('Press Ctrl+V anywhere on the screen to paste text or screenshots directly!');
    }
  };



  // Alt + and Alt - keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.altKey && (e.key === '+' || e.key === '=' || e.key === 'Add')) {
        e.preventDefault();
        setContentZoom(prev => {
          const next = Math.min(3.0, +(prev + 0.2).toFixed(1));
          if (saveFileViewState && file?.id) saveFileViewState(file.id, { zoom: next });
          return next;
        });
      } else if (e.altKey && (e.key === '-' || e.key === '_' || e.key === 'Subtract')) {
        e.preventDefault();
        setContentZoom(prev => {
          const next = Math.max(0.4, +(prev - 0.2).toFixed(1));
          if (saveFileViewState && file?.id) saveFileViewState(file.id, { zoom: next });
          return next;
        });
      } else if (e.altKey && (e.key === '0')) {
        e.preventDefault();
        setContentZoom(1);
        if (saveFileViewState && file?.id) saveFileViewState(file.id, { zoom: 1 });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [file?.id, saveFileViewState]);

  if (!file) return null;
  const currentIndex = allFiles.findIndex(f => f.id === file.id);
  
  const handlePrev = () => {
    if (currentIndex > 0) onSelectFile(allFiles[currentIndex - 1]);
  };
  const handleNext = () => {
    if (currentIndex < allFiles.length - 1) onSelectFile(allFiles[currentIndex + 1]);
  };

  const handleZoomIn = () => {
    const next = Math.min(3.0, +(contentZoom + 0.2).toFixed(1));
    handleZoomUpdate(next);
  };

  const handleZoomOut = () => {
    const next = Math.max(0.4, +(contentZoom - 0.2).toFixed(1));
    handleZoomUpdate(next);
  };

  const handleZoomReset = () => {
    handleZoomUpdate(1);
  };

  const handleTextScroll = (e) => {
    if (saveFileViewState && file?.id) {
      saveFileViewState(file.id, { textScrollTop: e.currentTarget.scrollTop });
    }
  };

  const handleImageScroll = (e) => {
    if (saveFileViewState && file?.id) {
      saveFileViewState(file.id, { 
        imageScrollTop: e.currentTarget.scrollTop,
        imageScrollLeft: e.currentTarget.scrollLeft
      });
    }
  };

  const getFileIcon = (type) => {
    switch (type) {
      case 'image': return <FileImage className="w-4 h-4 text-purple-400" />;
      case 'pdf': return <FileText className="w-4 h-4 text-red-400" />;
      default: return <FileCode className="w-4 h-4 text-blue-400" />;
    }
  };

  // High-performance Right-Side and Corner Drag Resizing (lag-free, smooth shrink & expand without merging)
  const handleResizeMouseDown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'se-resize';

    const startX = e.clientX;
    const startWidth = previewWidth;
    let rafId = null;

    const onMouseMove = (moveEvent) => {
      moveEvent.preventDefault();
      const dx = moveEvent.clientX - startX;
      // Calculate max width so preview window stops before colliding with open Node Inspector
      const sidebarLeftEdge = isSidebarOpen ? (sidebarWidth + 24) : 0;
      const maxAvailableForPreview = isSidebarOpen
        ? Math.max(260, window.innerWidth - sidebarLeftEdge - 24)
        : Math.floor(window.innerWidth * 0.5);

      const maxAllowedWidth = Math.min(Math.floor(window.innerWidth * 0.5), maxAvailableForPreview);
      const newWidth = Math.max(480, Math.min(maxAllowedWidth, Math.round(startWidth + dx)));
      
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        setPreviewWidth(newWidth);
      });
    };

    const onMouseUp = () => {
      setIsResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove, { passive: false });
    window.addEventListener('mouseup', onMouseUp);
  };

  const previewHeight = Math.round(previewWidth * (4 / 3));

  return (
    <>
      {isResizing && (
        <div className="fixed inset-0 z-99999 cursor-se-resize select-none pointer-events-auto bg-transparent" />
      )}

      {/* Right-Click Quick Actions Context Menu on Preview Window */}
      {contextMenu && (
        <div 
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px` }}
          className="fixed z-999999 bg-[#121215]/95 backdrop-blur-xl border border-zinc-700/80 rounded-xl shadow-[0_15px_35px_rgba(0,0,0,0.85)] p-1 min-w-52.5 animate-in fade-in zoom-in-95 duration-150"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={handlePasteClipboard}
            className="w-full px-3 py-2 text-xs font-medium text-purple-200 hover:text-white hover:bg-purple-600/20 rounded-lg flex items-center space-x-2.5 transition-colors cursor-pointer"
          >
            <ClipboardPaste className="w-4 h-4 text-purple-400" />
            <span>Paste from Clipboard (Ctrl+V)</span>
          </button>
          
          <div className="h-px bg-zinc-800 my-1" />

          <a
            href={file.url}
            download={file.name}
            onClick={() => setContextMenu(null)}
            className="w-full px-3 py-2 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 rounded-lg flex items-center space-x-2.5 transition-colors cursor-pointer"
          >
            <Download className="w-4 h-4 text-zinc-400" />
            <span className="truncate">Download {file.name}</span>
          </a>
        </div>
      )}

      <div 
        style={{ width: `${previewWidth}px`, height: `${previewHeight}px` }}
        onClick={() => onSelectSection && onSelectSection('preview')}
        onContextMenu={(e) => {
          e.preventDefault();
          setContextMenu({ x: e.clientX, y: e.clientY });
        }}
        className={`file-preview-modal fixed left-6 top-20 z-50 max-w-[50vw] max-h-[calc(100vh-5rem)] bg-[#0c0c0e]/95 backdrop-blur-2xl rounded-2xl shadow-[0_25px_60px_rgba(0,0,0,0.85)] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200 transition-all ${
          isDragTarget
            ? 'border-2 border-purple-500 ring-2 ring-purple-500/80 shadow-[0_0_35px_rgba(168,85,247,0.5)]'
            : (activeSection === 'preview'
                ? 'border-2 border-purple-500 ring-2 ring-purple-500/50 shadow-[0_0_30px_rgba(168,85,247,0.45)]'
                : 'border border-zinc-700/80 ring-1 ring-purple-500/20'
              )
        }`}
      >

      {/* Top Header with + and - Zoom Buttons, Copy Button, and Close */}
      <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-zinc-800 bg-zinc-900/90 flex-none select-none">
        <div className="flex items-center space-x-2 min-w-0 pr-1">
          {/* Reset Preview Size Button (top-left, dynamic color) */}
          <button
            type="button"
            onClick={() => setPreviewWidth(480)}
            className={`p-1.5 rounded-lg border flex items-center justify-center shrink-0 transition-all duration-300 cursor-pointer ${
              previewWidth === 480
                ? 'bg-zinc-800/80 text-white border-zinc-700/60 hover:bg-zinc-700/80'
                : 'bg-purple-500/20 text-purple-300 border-purple-500/50 ring-1 ring-purple-500/30 shadow-[0_0_14px_rgba(168,85,247,0.35)] hover:bg-purple-500/30'
            }`}
            title={previewWidth === 480 ? 'Preview is at default size' : 'Reset preview to default size'}
          >
            <RotateCcw className={`w-3.5 h-3.5 transition-transform duration-300 ${previewWidth !== 480 ? 'rotate-180 text-purple-400' : 'text-white'}`} />
          </button>

          <div className="p-1.5 bg-zinc-800 rounded-lg border border-zinc-700/50 shrink-0">
            {getFileIcon(file.type)}
          </div>
          <div className="min-w-0">
            <h4 className="text-xs sm:text-sm font-medium text-white truncate max-w-30 sm:max-w-42.5" title={file.name}>
              {file.name}
            </h4>
            <span className="text-[10px] text-zinc-400 uppercase font-mono tracking-wider">
              {file.type} • {file.sizeFormatted}
            </span>
          </div>
        </div>

        {/* Top Center-Right: Zoom, Paste & Copy Controls */}
        <div className="flex items-center space-x-1.5 shrink-0">
          
          {/* Quick Paste Text / Screenshot button */}
          <button
            type="button"
            onClick={handlePasteClipboard}
            className="px-2 py-1 text-xs font-medium bg-zinc-800/90 hover:bg-zinc-700 text-purple-300 hover:text-white rounded-lg transition-all flex items-center space-x-1 cursor-pointer border border-zinc-700/60 shadow-sm"
            title="Paste Text or Screenshot from clipboard (Ctrl+V / Right-Click)"
          >
            <ClipboardPaste className="w-3.5 h-3.5 text-purple-400" />
            <span className="hidden sm:inline">Paste</span>
          </button>


          
          {/* 1-Click Copy Button for text/code files */}
          {file.type === 'text' && (
            <button
              type="button"
              onClick={handleCopyText}
              className={`px-2 py-1 text-xs font-medium rounded-lg transition-all flex items-center space-x-1.5 cursor-pointer border ${
                copied 
                  ? 'bg-green-500/20 text-green-300 border-green-500/40 ring-1 ring-green-500/30' 
                  : 'bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white border-zinc-700/60'
              }`}
              title="Copy entire text content (Ctrl+C / Click)"
            >
              {copied ? (
                <>
                  <Check className="w-3.5 h-3.5 text-green-400" />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 text-purple-400" />
                  <span>Copy</span>
                </>
              )}
            </button>
          )}

          {file.type !== 'pdf' && (
            <div className="flex items-center bg-zinc-950/80 border border-zinc-700/60 rounded-lg p-0.5 shadow-sm">
              <button
                type="button"
                onClick={handleZoomOut}
                className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Zoom Out (Alt + -)"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={handleZoomReset}
                className="px-1.5 text-[10px] text-zinc-300 font-mono hover:text-purple-300 cursor-pointer"
                title="Reset Zoom (Alt + 0)"
              >
                {Math.round(contentZoom * 100)}%
              </button>
              <button
                type="button"
                onClick={handleZoomIn}
                className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Zoom In (Alt + +)"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Top Right Cross to Close Preview */}
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer border border-transparent hover:border-zinc-700 ml-1"
            title="Close Preview"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Preview Content Body (Vertical 3:4 with Content Zoom & Scroll Persistence) */}
      <div className="grow overflow-hidden p-3 bg-zinc-950/70 flex items-center justify-center relative">
        {file.type === 'image' && (
          <div 
            ref={imageContainerRef}
            onScroll={handleImageScroll}
            className="w-full h-full overflow-auto rounded-xl bg-[radial-gradient(#27272a_1px,transparent_1px)] bg-size-[16px_16px] p-3 border border-zinc-800/60 flex items-center justify-center select-none"
          >
            <div 
              style={{
                transform: `scale(${contentZoom})`,
                transformOrigin: 'center center',
                transition: 'transform 0.15s ease-out'
              }}
              className="flex items-center justify-center shrink-0"
            >
              <img 
                src={file.url} 
                alt={file.name} 
                className="max-h-87.5 w-auto object-contain rounded-lg shadow-md select-none pointer-events-none"
              />
            </div>
          </div>
        )}

        {file.type === 'pdf' && (
          <div className="w-full h-full flex flex-col rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900 relative">
            <PdfViewer 
              key={file.id}
              url={file.url} 
              fileId={file.id} 
              zoom={contentZoom} 
              initialViewState={getFileViewState ? getFileViewState(file.id) : {}}
              onSaveViewState={saveFileViewState}
            />
          </div>
        )}

        {file.type === 'text' && (
          <div 
            ref={textContainerRef}
            onScroll={handleTextScroll}
            className="w-full h-full overflow-auto rounded-xl bg-zinc-900/95 border border-zinc-800 p-3.5 select-text cursor-text"
          >
            <pre 
              style={{ 
                transform: `scale(${contentZoom})`,
                transformOrigin: 'top left',
                width: `${100 / Math.max(0.4, contentZoom)}%`,
                transition: 'transform 0.15s ease-out'
              }}
              className="font-mono text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed selection:bg-purple-500 selection:text-white select-text cursor-text"
            >
              {file.textContent || 'No text content available'}
            </pre>
          </div>
        )}
      </div>

      {/* Bottom Footer: Left (Navigation), Middle (Delete button), Right (Download) */}
      <div className="p-2.5 border-t border-zinc-800 bg-zinc-900/90 flex items-center justify-between flex-none text-xs select-none">
        {/* Left: Previous / Next Controls */}
        <div className="flex items-center space-x-1 text-zinc-400 font-mono">
          <button
            type="button"
            disabled={currentIndex <= 0}
            onClick={handlePrev}
            className="p-1 rounded hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
            title="Previous file"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span>{currentIndex + 1} / {allFiles.length}</span>
          <button
            type="button"
            disabled={currentIndex >= allFiles.length - 1}
            onClick={handleNext}
            className="p-1 rounded hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent cursor-pointer"
            title="Next file"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Middle: Delete File Button */}
        <button
          type="button"
          onClick={() => onDeleteFile && onDeleteFile(file.id)}
          className="px-2.5 py-1 text-xs font-medium text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 rounded-lg flex items-center space-x-1.5 transition-all cursor-pointer shadow-sm"
          title="Delete this file"
        >
          <Trash2 className="w-3.5 h-3.5 text-red-400" />
          <span>Delete</span>
        </button>

        {/* Right / Shifted Left: Download File Button */}
        <div className="flex items-center mr-12 sm:mr-16">
          <a
            href={file.url}
            download={file.name}
            className="px-2.5 py-1 text-xs font-medium text-zinc-300 hover:text-white bg-zinc-800/90 hover:bg-zinc-700 rounded-lg transition-colors border border-zinc-700/60 flex items-center space-x-1.5 shadow-sm cursor-pointer"
            title="Download file"
          >
            <Download className="w-3.5 h-3.5 text-purple-400" />
            <span className="hidden sm:inline">Download</span>
          </a>
        </div>
      </div>


      {/* Right-Side Edge Resize Handle (Expands rightward up to half the website) */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute top-0 right-0 w-3.5 h-full cursor-ew-resize hover:bg-purple-500/40 transition-colors z-30 select-none"
        title="Hold & drag right side to resize (up to half of the website)"
      />

      {/* Bottom-Right Corner Resize Grip */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute bottom-0 right-0 w-8 h-8 cursor-se-resize flex items-end justify-end p-2 text-zinc-500 hover:text-purple-400 transition-colors z-40 group select-none"
        title="Hold & drag corner to resize (up to half of the website, 3:4 ratio)"
      >
        <svg viewBox="0 0 10 10" className="w-3.5 h-3.5 fill-current group-hover:scale-125 transition-transform">
          <line x1="8" y1="2" x2="2" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="5" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="8" y1="8" x2="8" y2="8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </div>
    </>
  );
};

export default FilePreviewModal;
