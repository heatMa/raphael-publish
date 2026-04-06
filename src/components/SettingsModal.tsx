import { useState, useEffect } from 'react';
import { X, ExternalLink } from 'lucide-react';
import { getSettings, saveSettings } from '../lib/settings';

interface SettingsModalProps {
    onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
    const [apiKey, setApiKey] = useState('');

    useEffect(() => {
        setApiKey(getSettings().imgbbApiKey);
    }, []);

    const handleSave = () => {
        saveSettings({ imgbbApiKey: apiKey.trim() });
        onClose();
    };

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="bg-white dark:bg-[#1c1c1e] rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6">
                <div className="flex items-center justify-between mb-5">
                    <h2 className="text-[17px] font-semibold text-[#1d1d1f] dark:text-[#f5f5f7]">设置</h2>
                    <button
                        onClick={onClose}
                        className="p-1.5 rounded-full hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="space-y-4">
                    <div>
                        <label className="block text-[13px] font-medium text-[#1d1d1f] dark:text-[#f5f5f7] mb-1.5">
                            imgbb API Key
                        </label>
                        <p className="text-[12px] text-[#86868b] dark:text-[#a1a1a6] mb-2">
                            「复制到知乎」时，图片会上传到 imgbb 获取公开链接（知乎后端无法访问飞书内嵌图片）。
                        </p>
                        <input
                            type="password"
                            value={apiKey}
                            onChange={e => setApiKey(e.target.value)}
                            placeholder="填入 imgbb API Key"
                            className="w-full px-3 py-2 rounded-lg border border-[#d2d2d7] dark:border-[#3a3a3c] bg-transparent text-[14px] text-[#1d1d1f] dark:text-[#f5f5f7] placeholder-[#86868b] outline-none focus:border-[#0066cc] dark:focus:border-[#0a84ff] transition-colors"
                        />
                        <a
                            href="https://api.imgbb.com/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 mt-1.5 text-[12px] text-[#0066cc] dark:text-[#0a84ff] hover:underline"
                        >
                            在 imgbb 免费注册获取 API Key <ExternalLink size={11} />
                        </a>
                    </div>
                </div>

                <div className="flex justify-end gap-3 mt-6">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 rounded-lg text-[14px] text-[#86868b] hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                    >
                        取消
                    </button>
                    <button
                        onClick={handleSave}
                        className="px-4 py-2 rounded-lg text-[14px] font-medium bg-[#0066cc] dark:bg-[#0a84ff] text-white hover:opacity-90 transition-opacity"
                    >
                        保存
                    </button>
                </div>
            </div>
        </div>
    );
}
