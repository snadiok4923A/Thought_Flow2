import React, { useState, useEffect, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ChevronUp, ChevronDown, ZoomIn, ZoomOut } from 'lucide-react';
import { globalPdfCache } from '../utils/pdfCache';

// Clean Canvas-based PDF Viewer with State Persistence (restores exact page & scroll position)
const PdfViewer = ({ url, fileId, zoom = 1, initialViewState = {}, onSaveViewState }) => {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [pdfDoc, setPdfDoc] = useState(null);
  const [currentPage, setCurrentPage] = useState(initialViewState?.page || 1);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const renderTaskRef = useRef(null);
  const hasRestoredScrollRef = useRef(false);

  useEffect(() => {
    let isCancelled = false;

    const loadPdf = async () => {
      try {
        if (globalPdfCache.has(url)) {
          const doc = globalPdfCache.get(url);
          if (!isCancelled) {
            setPdfDoc(doc);
            setTotalPages(doc.numPages);
            const restoredPage = Math.min(doc.numPages, Math.max(1, initialViewState?.page || 1));
            setCurrentPage(restoredPage);
            setIsLoading(false);
            setError(null);
          }
          return;
        }

        const loadingTask = pdfjsLib.getDocument(url);
        const doc = await loadingTask.promise;
        globalPdfCache.set(url, doc);

        if (!isCancelled) {
          setPdfDoc(doc);
          setTotalPages(doc.numPages);
          const restoredPage = Math.min(doc.numPages, Math.max(1, initialViewState?.page || 1));
          setCurrentPage(restoredPage);
          setIsLoading(false);
          setError(null);
        }
      } catch (err) {
        console.error('PDF load error:', err);
        if (!isCancelled) {
          setError('Failed to load PDF preview');
          setIsLoading(false);
        }
      }
    };

    loadPdf();
    return () => {
      isCancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let isCancelled = false;

    const renderPage = async () => {
      try {
        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
        }

        const page = await pdfDoc.getPage(currentPage);
        if (isCancelled || !canvasRef.current) return;

        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        // Render at 2.0x base resolution for sharp text at any zoom level
        const viewport = page.getViewport({ scale: 2.0 });

        canvas.width = viewport.width;
        canvas.height = viewport.height;

        const renderContext = {
          canvasContext: ctx,
          viewport: viewport
        };

        const renderTask = page.render(renderContext);
        renderTaskRef.current = renderTask;
        await renderTask.promise;

        // Restore scroll position after initial page render
        if (!hasRestoredScrollRef.current && containerRef.current) {
          if (initialViewState?.pdfScrollTop !== undefined) {
            containerRef.current.scrollTop = initialViewState.pdfScrollTop;
          }
          if (initialViewState?.pdfScrollLeft !== undefined) {
            containerRef.current.scrollLeft = initialViewState.pdfScrollLeft;
          }
          hasRestoredScrollRef.current = true;
        }
      } catch (err) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Render page error:', err);
        }
      }
    };

    renderPage();
    return () => {
      isCancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, currentPage]);

  const handlePageChange = (newPage) => {
    setCurrentPage(newPage);
    if (onSaveViewState && fileId) {
      onSaveViewState(fileId, { page: newPage, pdfScrollTop: 0, pdfScrollLeft: 0 });
    }
  };

  const handleScroll = (e) => {
    if (onSaveViewState && fileId) {
      onSaveViewState(fileId, {
        pdfScrollTop: e.currentTarget.scrollTop,
        pdfScrollLeft: e.currentTarget.scrollLeft
      });
    }
  };

  if (error) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center p-4 text-center">
        <object 
          data={`${url}#toolbar=0&navpanes=0&scrollbar=0`} 
          type="application/pdf" 
          className="w-full h-full rounded-xl border border-zinc-800"
        >
          <p className="text-zinc-400 text-xs">PDF preview not supported directly in this browser view.</p>
        </object>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-between relative overflow-hidden bg-zinc-950">
      {isLoading ? (
        <div className="flex-grow flex flex-col items-center justify-center text-zinc-400 space-y-2">
          <div className="w-6 h-6 border-2 border-purple-500 border-t-transparent rounded-full animate-spin"></div>
          <span className="text-xs">Rendering PDF...</span>
        </div>
      ) : (
        <div 
          ref={containerRef}
          onScroll={handleScroll}
          className="flex-grow w-full h-full overflow-auto flex items-center justify-center p-3"
        >
          <div 
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
              transition: 'transform 0.15s ease-out'
            }}
            className="flex items-center justify-center flex-shrink-0"
          >
            <canvas 
              ref={canvasRef} 
              className="max-h-[350px] w-auto rounded-lg shadow-2xl bg-white block" 
            />
          </div>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center space-x-2 py-1 px-3 bg-zinc-900/95 border border-zinc-800 rounded-full text-xs text-zinc-300 shadow-xl flex-none my-1 z-10 backdrop-blur-md">
          <button
            type="button"
            disabled={currentPage <= 1}
            onClick={() => handlePageChange(Math.max(1, currentPage - 1))}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
          >
            ‹
          </button>
          <span className="font-mono text-[11px]">Page {currentPage} / {totalPages}</span>
          <button
            type="button"
            disabled={currentPage >= totalPages}
            onClick={() => handlePageChange(Math.min(totalPages, currentPage + 1))}
            className="px-1.5 py-0.5 rounded hover:bg-zinc-800 disabled:opacity-30 cursor-pointer"
          >
            ›
          </button>
        </div>
      )}
    </div>
  );
};

// 3:4 Vertical Preview Modal Component with Zoom Controls, 3:4 Corner Resizing & View State Persistence


export default PdfViewer;