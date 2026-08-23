export // Helper to format file size
const formatFileSize = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
};

export // Shared helper to read files (images/screenshots or text) from system clipboard
const readClipboardAsFiles = async () => {
  if (!navigator.clipboard) return null;
  // 1. Try reading images/blobs first
  if (navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      const filesToImport = [];
      for (const item of items) {
        for (const type of item.types) {
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const fileObj = new File(
              [blob], 
              `Screenshot_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`, 
              { type }
            );
            filesToImport.push(fileObj);
          }
        }
      }
      if (filesToImport.length > 0) {
        return filesToImport;
      }
    } catch {
      // Fallback to text
    }
  }

  // 2. Try reading plain text
  if (navigator.clipboard.readText) {
    const text = await navigator.clipboard.readText();
    if (text && text.trim()) {
      const cleanText = text.trim();
      const firstLine = cleanText.split('\n')[0].replace(/[^\w\s-]/gi, '').trim().slice(0, 24);
      const title = firstLine.length > 2 ? `${firstLine}.txt` : `Pasted_Note_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
      const blob = new Blob([cleanText], { type: 'text/plain;charset=utf-8' });
      const fileObj = new File([blob], title, { type: 'text/plain' });
      return [fileObj];
    }
  }
  return null;
};

