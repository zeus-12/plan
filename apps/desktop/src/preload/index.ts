import { contextBridge, ipcRenderer } from "electron";

const electronAPI = {
  getInit: () => ipcRenderer.invoke("auto:init"),
  onAutoContent: (callback: (content: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, content: string) =>
      callback(content);
    ipcRenderer.on("auto:content", handler);
    return () => ipcRenderer.removeListener("auto:content", handler);
  },
  saveSession: (filePath: string, versions: unknown[]) => {
    ipcRenderer.send("session:save", { filePath, versions });
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);
