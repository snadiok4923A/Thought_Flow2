import React, { useState, useRef } from 'react';
import { Upload, Trash2, Maximize2, FileImage, ClipboardPaste, Plus, ZoomOut, ZoomIn, RotateCcw, X } from 'lucide-react';

const NodePhotosManager = ({ images = [], onAddImages, onDeleteImage, onViewPhoto }) => {
  const [selectedPhoto, setSelectedPhoto] = useState(null);
  const [localZoom, setLocalZoom] = useState(1);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef(null);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddImages(Array.from(e.target.files));
      e.target.value = '';
    }
  };

  const handlePasteScreenshot = async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        const imageFiles = [];
        for (const item of items) {
          for (const type of item.types) {
            if (type.startsWith('image/')) {
              const blob = await item.getType(type);
              const ext = type.split('/')[1] || 'png';
              const file = new File(
                [blob], 
                `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`, 
                { type }
              );
              imageFiles.push(file);
            }
          }
        }
        if (imageFiles.length > 0) {
          onAddImages(imageFiles);
          return;
        }
      }
      alert('Press Ctrl+V to paste screenshot or copied image directly into this Node!');
    } catch {
      alert('Press Ctrl+V to paste screenshot or copied image directly into this Node!');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDraggingOver(true);
  };

  const handleDragLeave = () => {
    setIsDraggingOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDraggingOver(false);
  };

  return (
    <div 
      className="flex flex-col h-full overflow-hidden relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <input 
        type="file" 
        ref={fileInputRef} 
        onChange={handleFileChange} 
        accept="image/*" 
        multiple 
        className="hidden" 
      />

      {images.length === 0 ? (
        // Empty State: Prominent Import File & Paste Screenshot buttons + Dropzone
        <div className={`flex flex-col items-center justify-center h-full p-6 text-center rounded-2xl border-2 border-dashed transition-all duration-300 ${
          isDraggingOver 
            ? 'border-purple-500 bg-purple-500/15 ring-2 ring-purple-500/30' 
            : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-700'
        }`}>
          <div className="w-16 h-16 rounded-2xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center mb-4 text-purple-400 shadow-[0_0_20px_rgba(168,85,247,0.2)]">
            <FileImage className="w-8 h-8" />
          </div>
          
          <h4 className="text-sm font-semibold text-white mb-1">No Photos Attached Yet</h4>
          <p className="text-xs text-zinc-400 max-w-xs mb-6">
            Attach screenshots, mockups, or diagrams directly to this thought node.
          </p>

          <div className="flex flex-col sm:flex-row items-center gap-3 w-full max-w-xs">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="w-full px-4 py-2.5 bg-purple-600 hover:bg-purple-500 text-white rounded-xl text-xs font-semibold flex items-center justify-center space-x-2 shadow-lg shadow-purple-600/30 transition-all cursor-pointer"
            >
              <Upload className="w-4 h-4" />
              <span>Import File</span>
            </button>

            <button
              type="button"
              onClick={handlePasteScreenshot}
              className="w-full px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-purple-300 hover:text-white rounded-xl text-xs font-semibold flex items-center justify-center space-x-2 border border-zinc-700 transition-all cursor-pointer"
              title="Paste screenshot from clipboard (or press Ctrl+V)"
            >
              <ClipboardPaste className="w-4 h-4 text-purple-400" />
              <span>Paste Screenshot</span>
            </button>
          </div>

          <div className="mt-6 text-[11px] text-zinc-500 font-mono flex items-center space-x-1.5">
            <span>Tip: Drag & drop images here or press</span>
            <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300">Ctrl+V</kbd>
          </div>
        </div>
      ) : (
        // Populated State: Gallery & Actions
        <div className="flex flex-col h-full overflow-hidden">
          {/* Action bar */}
          <div className="flex items-center justify-between mb-3 pb-2 border-b border-zinc-800/80 flex-none">
            <span className="text-xs font-semibold text-zinc-400">
              Attached Photos ({images.length})
            </span>
            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="px-2.5 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-medium flex items-center space-x-1.5 border border-zinc-700/80 transition-colors cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5 text-purple-400" />
                <span>Add Photo</span>
              </button>
              <button
                type="button"
                onClick={handlePasteScreenshot}
                className="px-2.5 py-1.5 bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded-lg text-xs font-medium flex items-center space-x-1.5 border border-purple-500/40 transition-colors cursor-pointer"
              >
                <ClipboardPaste className="w-3.5 h-3.5 text-purple-400" />
                <span>Paste</span>
              </button>
            </div>
          </div>

          {/* Photos Grid */}
          <div className="flex-grow overflow-y-auto no-scrollbar grid grid-cols-2 gap-3 p-1">
            {images.map((img) => (
              <div 
                key={img.id}
                onClick={() => {
                  if (onViewPhoto) {
                    onViewPhoto(img);
                  } else {
                    setSelectedPhoto(img);
                  }
                }}
                className="group relative rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800 hover:border-purple-500/60 shadow-lg transition-all duration-200 aspect-square flex flex-col cursor-pointer"
                title="Click to view image"
              >
                <img 
                  src={img.url} 
                  alt="Photo" 
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 pointer-events-none"
                />

                {/* Dark overlay on hover */}
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-start items-end p-2 pointer-events-none">
                  <div className="pointer-events-auto">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteImage(img.id);
                      }}
                      className="p-1.5 bg-red-500/80 hover:bg-red-600 text-white rounded-lg transition-colors cursor-pointer shadow-md"
                      title="Delete Photo"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Inline Container Photo Preview (Clean view with ONLY Zoom and Close buttons) */}
      {selectedPhoto && (
        <div className="absolute inset-0 z-30 bg-[#0c0c0e]/98 flex flex-col overflow-hidden animate-in fade-in duration-150">
          <div className="flex items-center justify-between px-3.5 py-2 border-b border-zinc-800 bg-zinc-900/90 select-none">
            {/* ONLY Zoom & Close Controls */}
            <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-lg p-0.5">
              <button
                type="button"
                onClick={() => setLocalZoom(z => Math.max(0.25, Math.round((z - 0.2) * 10) / 10))}
                className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Zoom Out"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="text-[11px] px-2 text-zinc-300 font-mono select-none min-w-[40px] text-center">
                {Math.round(localZoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setLocalZoom(z => Math.min(4, Math.round((z + 0.2) * 10) / 10))}
                className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                title="Zoom In"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setLocalZoom(1)}
                className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer border-l border-zinc-800 ml-0.5"
                title="Reset Zoom"
              >
                <RotateCcw className="w-3 h-3" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => { setSelectedPhoto(null); setLocalZoom(1); }}
              className="p-1.5 text-zinc-400 hover:text-white hover:bg-red-500/20 rounded-lg transition-colors cursor-pointer"
              title="Close Preview"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div 
            className="flex-grow p-3 flex items-center justify-center overflow-auto bg-zinc-950/80"
            onWheel={(e) => {
              e.preventDefault();
              setLocalZoom(z => Math.max(0.25, Math.min(4, Math.round((z + (e.deltaY < 0 ? 0.15 : -0.15)) * 100) / 100)));
            }}
          >
            <img 
              src={selectedPhoto.url} 
              alt="" 
              style={{ transform: `scale(${localZoom})`, transformOrigin: 'center center', transition: 'transform 0.1s ease-out' }}
              className="max-h-full max-w-full object-contain rounded-lg shadow-xl pointer-events-none"
            />
          </div>
        </div>
      )}
    </div>
  );
};



export default NodePhotosManager;
