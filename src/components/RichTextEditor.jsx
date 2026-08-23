import React, { useState, useEffect, useRef } from 'react';
import { Bold, Italic, List, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { hasTextContent } from '../utils/treeUtils';
const RichTextEditor = ({ initialContent, onChange }) => {
  const editorRef = useRef(null);
  const [noteZoom, setNoteZoom] = useState(1);

  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.innerHTML = initialContent || '';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only set initial content once on mount (component remounts when active node changes)

  // Sync external changes (e.g. from Undo/Redo) when the editor is not actively being edited
  useEffect(() => {
    if (editorRef.current && document.activeElement !== editorRef.current) {
      if (editorRef.current.innerHTML !== (initialContent || '')) {
        editorRef.current.innerHTML = initialContent || '';
      }
    }
  }, [initialContent]);

  const execCmd = (cmd) => {
    document.execCommand(cmd, false, null);
    if (editorRef.current) {
      editorRef.current.focus();
      const html = editorRef.current.innerHTML;
      onChange(hasTextContent(html) ? html : '');
    }
  };

  const handleInput = (e) => {
    const html = e.currentTarget.innerHTML;
    onChange(hasTextContent(html) ? html : '');
  };

  const handleZoomIn = () => {
    setNoteZoom(prev => Math.min(2.5, +(prev + 0.15).toFixed(2)));
  };

  const handleZoomOut = () => {
    setNoteZoom(prev => Math.max(0.6, +(prev - 0.15).toFixed(2)));
  };

  const handleZoomReset = () => {
    setNoteZoom(1);
  };

  return (
    <div className="flex flex-col h-full border border-zinc-800 rounded-xl overflow-hidden bg-zinc-900/50">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-1">
          <button 
            type="button"
            onMouseDown={(e) => { e.preventDefault(); execCmd('bold'); }} 
            className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer" 
            title="Bold"
          >
            <Bold size={16}/>
          </button>
          <button 
            type="button"
            onMouseDown={(e) => { e.preventDefault(); execCmd('italic'); }} 
            className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer" 
            title="Italic"
          >
            <Italic size={16}/>
          </button>
          <div className="w-px h-4 bg-zinc-700 mx-1"></div>
          <button 
            type="button"
            onMouseDown={(e) => { e.preventDefault(); execCmd('insertUnorderedList'); }} 
            className="p-1.5 hover:bg-zinc-800 rounded text-zinc-400 hover:text-white transition-colors cursor-pointer" 
            title="Bullet List"
          >
            <List size={16}/>
          </button>
        </div>

        {/* Right Side: Zoom Controls */}
        <div className="flex items-center space-x-1 bg-zinc-950/80 border border-zinc-800 rounded-lg p-0.5 shadow-sm">
          <button
            type="button"
            onClick={handleZoomOut}
            className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Zoom Out Notes"
          >
            <ZoomOut size={14} />
          </button>
          <button
            type="button"
            onClick={handleZoomReset}
            className="px-1.5 text-[10px] text-zinc-300 font-mono hover:text-purple-300 cursor-pointer"
            title="Reset Zoom (100%)"
          >
            {Math.round(noteZoom * 100)}%
          </button>
          <button
            type="button"
            onClick={handleZoomIn}
            className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Zoom In Notes"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* Editor Content Area */}
      <div 
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning={true}
        data-placeholder="Write your detailed thoughts and explanations here..."
        style={{
          fontSize: `${Math.round(14 * noteZoom)}px`,
          lineHeight: 1.7
        }}
        className="rich-text-content flex-grow p-4 outline-none text-zinc-200 overflow-y-auto leading-relaxed"
        onInput={handleInput}
        onBlur={handleInput}
      />
    </div>
  );
};

// Node Photos Manager Component


export default RichTextEditor;
