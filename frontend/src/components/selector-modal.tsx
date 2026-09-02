import { useState, useEffect } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Download, Brain, Check, RefreshCw, AlertCircle, Trash2, Cloud } from "lucide-react"
import { toast } from "sonner"
import { useSettings } from "@/context/SettingsContext"

interface AIModel {
  displayName: string
  description: string
  fileName: string
  link: string
  type: string
  file_exists?: boolean
  file_size_readable?: string
  model_folder?: string
}

interface OllamaCloudModel {
  modelId: string
  displayName: string
  description: string
  role: string
  type: string
}

interface DownloadProgress {
  model_name: string
  status: 'starting' | 'downloading' | 'completed' | 'error' | 'cancelled'
  progress: number
  total_size: number
  downloaded_size: number
  error?: string
  download_speed?: string
  elapsed_time?: number
}

interface OllamaStatus {
  api_key_set: boolean
  connected: boolean
  error: string | null
}

const ROLE_BADGE_LABELS: Record<string, string> = {
  default: "Default",
  conversational: "Conversational",
  balanced: "Balanced",
  premium: "Premium",
}

export default function AIModelSelector() {
  const { settings, updateSetting } = useSettings()
  const provider = settings["llm.provider"] ?? "ollama_cloud"
  const isOllamaCloud = provider === "ollama_cloud"

  const [open, setOpen] = useState(false)
  const [internalSelected, setInternalSelected] = useState<AIModel | null>(null)
  const [internalSelectedOllama, setInternalSelectedOllama] = useState<OllamaCloudModel | null>(null)
  const [models, setModels] = useState<AIModel[]>([])
  const [ollamaModels, setOllamaModels] = useState<OllamaCloudModel[]>([])
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [downloading, setDownloading] = useState<Record<string, string>>({})
  const [downloadProgress, setDownloadProgress] = useState<Record<string, DownloadProgress>>({})

  const loadGgufModels = async () => {
    const res = await fetch("/api/llm/models")
    const data = await res.json()
    setModels(data.models || [])
    if (data.currentModel) {
      setInternalSelected(data.currentModel)
    }
  }

  const loadOllamaModels = async () => {
    const res = await fetch("/api/llm/ollama/models")
    const data = await res.json()
    setOllamaModels(data.models || [])
    setOllamaStatus(data.ollamaStatus || null)
    const currentModelId = settings["llm.ollama.model"] ?? data.currentModel
    const current = (data.models || []).find((m: OllamaCloudModel) => m.modelId === currentModelId)
    if (current) {
      setInternalSelectedOllama(current)
    } else if (data.models?.length > 0) {
      setInternalSelectedOllama(data.models[0])
    }
  }

  const loadModels = async () => {
    try {
      setLoading(true)
      if (isOllamaCloud) {
        await loadOllamaModels()
      } else {
        await loadGgufModels()
      }
      setLoading(false)
    } catch (error) {
      console.error("Failed to load models:", error)
      setLoading(false)
    }
  }

  useEffect(() => {
    loadModels()
  }, [isOllamaCloud, open])

  useEffect(() => {
    if (isOllamaCloud) {
      const currentModelId = settings["llm.ollama.model"]
      if (currentModelId && ollamaModels.length > 0) {
        const current = ollamaModels.find((m) => m.modelId === currentModelId)
        if (current) setInternalSelectedOllama(current)
      }
    }
  }, [settings["llm.ollama.model"], ollamaModels, isOllamaCloud])

  useEffect(() => {
    const pollProgress = async () => {
      for (const [modelName, downloadId] of Object.entries(downloading)) {
        try {
          const res = await fetch(`/api/llm/models/download/${downloadId}/progress`)
          if (res.ok) {
            const progress = await res.json()
            setDownloadProgress(prev => ({
              ...prev,
              [modelName]: progress
            }))
            
            if (progress.status === 'completed' || progress.status === 'error') {
              setDownloading(prev => {
                const newDownloading = { ...prev }
                delete newDownloading[modelName]
                return newDownloading
              })
              
              if (progress.status === 'completed') {
                await loadGgufModels()
              }
            }
          }
        } catch (error) {
          console.error(`Failed to get progress for ${downloadId}:`, error)
        }
      }
    }

    if (Object.keys(downloading).length > 0) {
      const interval = setInterval(pollProgress, 1000)
      return () => clearInterval(interval)
    }
  }, [downloading])

  const handleModelSelect = (model: AIModel) => {
    setInternalSelected(model)
    updateSetting("llm.model_filename", model.fileName)
    setOpen(false)
  }

  const handleOllamaModelSelect = (model: OllamaCloudModel) => {
    setInternalSelectedOllama(model)
    updateSetting("llm.ollama.model", model.modelId)
    setOpen(false)
  }

  const handleDownload = async (model: AIModel) => {
    try {
      const res = await fetch("/api/llm/models/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: model.displayName
        })
      })

      const data = await res.json()
      
      if (res.ok) {
        setDownloading(prev => ({
          ...prev,
          [model.fileName]: data.download_id
        }))
        setDownloadProgress(prev => ({
          ...prev,
          [model.fileName]: {
            model_name: model.fileName,
            status: 'starting',
            progress: 0,
            total_size: 0,
            downloaded_size: 0
          }
        }))
      } else {
        toast.error(`Download failed: ${data.error}`)
      }
    } catch (error) {
      console.error("Download failed:", error)
      toast.error("Download failed: Network error")
    }
  }

  const handleDelete = async (model: AIModel) => {
    if (!confirm(`Are you sure you want to delete ${model.displayName}?`)) {
      return
    }
    
    try {
      const res = await fetch("/api/llm/models/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model_id: model.displayName
        })
      })

      const data = await res.json()
      
      if (res.ok) {
        await loadGgufModels()
        
        if (internalSelected?.displayName === model.displayName) {
          setInternalSelected(null)
        }
      } else {
        toast.error(`Delete failed: ${data.error}`)
      }
    } catch (error) {
      console.error("Delete failed:", error)
      toast.error("Delete failed: Network error")
    }
  }

  const getStatusBadge = (model: AIModel) => {
    const isDownloading = model.fileName in downloading
    const progress = downloadProgress[model.fileName]

    if (isDownloading && progress) {
      if (progress.status === 'error') {
        return <Badge variant="destructive" className="ml-auto">Download Failed</Badge>
      } else if (progress.status === 'completed') {
        return <Badge variant="default" className="ml-aut">Downloaded</Badge>
      } else {
        return <Badge variant="secondary" className="ml-auto">Downloading...</Badge>
      }
    }

    if (model.file_exists) {
      return <Badge variant="default" className="ml-auto">Downloaded</Badge>
    } else {
      return <Badge variant="outline" className="ml-auto">Not Downloaded</Badge>
    }
  }

  const getRoleBadge = (role: string) => {
    const label = ROLE_BADGE_LABELS[role] ?? role
    return <Badge variant="secondary" className="ml-auto">{label}</Badge>
  }

  const selectedLabel = isOllamaCloud
    ? (internalSelectedOllama?.displayName ?? "Select Cloud Model")
    : (internalSelected?.displayName ?? "Select AI Model")

  if (loading) return (
    <Button variant="outline" className="w-full overflow-hidden text-ellipsis justify-start" disabled>
      <Brain className="mr-2 h-4 w-4" />
      Loading models...
    </Button>
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="w-full overflow-hidden text-ellipsis justify-start">
          {isOllamaCloud ? <Cloud className="mr-2 h-4 w-4" /> : <Brain className="mr-2 h-4 w-4" />}
          {selectedLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto scrollbar-hide">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isOllamaCloud ? <Cloud className="h-5 w-5" /> : <Brain className="h-5 w-5" />}
            {isOllamaCloud ? "Select Ollama Cloud Model" : "Select AI Model"}
          </DialogTitle>
        </DialogHeader>

        {isOllamaCloud && ollamaStatus && !ollamaStatus.connected && (
          <div className="flex items-center gap-2 text-sm p-3 rounded-md bg-yellow-500/10 text-yellow-600 dark:text-yellow-400">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{ollamaStatus.error ?? "OLLAMA_API_KEY not configured. Set the environment variable and restart the server."}</span>
          </div>
        )}

        <div className="grid gap-4 py-4">
          {isOllamaCloud ? (
            ollamaModels.map((model) => (
              <Card
                key={model.modelId}
                className={`cursor-pointer transition-all hover:shadow-md ${
                  internalSelectedOllama?.modelId === model.modelId ? "ring-2 ring-primary bg-primary/5" : ""
                }`}
                onClick={() => handleOllamaModelSelect(model)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        <CardTitle className="text-lg">{model.displayName}</CardTitle>
                        {internalSelectedOllama?.modelId === model.modelId && (
                          <Check className="h-4 w-4 text-primary" />
                        )}
                        {getRoleBadge(model.role)}
                      </div>
                      <CardDescription className="text-sm">{model.description}</CardDescription>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <span className="font-mono text-sm text-muted-foreground">{model.modelId}</span>
                </CardContent>
              </Card>
            ))
          ) : (
            models.map((model, index) => {
              const isDownloading = model.fileName in downloading
              const progress = downloadProgress[model.fileName]
              
              return (
                <Card
                  key={index}
                  className={`cursor-pointer transition-all hover:shadow-md ${
                    internalSelected?.displayName === model.displayName ? "ring-2 ring-primary bg-primary/5" : ""
                  }`}
                  onClick={() => model.file_exists && handleModelSelect(model)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <CardTitle className="text-lg">{model.displayName}</CardTitle>
                          {internalSelected?.displayName === model.displayName && (
                            <Check className="h-4 w-4 text-primary" />
                          )}
                          {getStatusBadge(model)}
                        </div>
                        <CardDescription className="text-sm">{model.description}</CardDescription>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between text-sm text-muted-foreground">
                        <div className="flex items-center gap-6">
                          <span className="font-mono whitespace-nowrap overflow-hidden text-ellipsis w-40">{model.fileName}</span>
                          <span className="font-medium shrink-0">
                            {model.file_size_readable || 'Unknown size'}
                          </span>
                        </div>
                        
                        {isDownloading && progress && progress.status !== 'error' && (
                          <div className="flex items-center gap-2">
                            {progress.status === 'downloading' && (
                              <RefreshCw className="h-3 w-3 animate-spin" />
                            )}
                            <span className="text-xs">
                              {progress.status === 'starting' && 'Starting...'}
                              {progress.status === 'downloading' && `${Math.round(progress.progress)}%`}
                              {progress.status === 'completed' && 'Complete'}
                            </span>
                          </div>
                        )}
                        
                        {progress?.status === 'error' && (
                          <div className="flex items-center gap-2 text-red-500">
                            <AlertCircle className="h-3 w-3" />
                            <span className="text-xs">Failed</span>
                          </div>
                        )}
                        
                        {!isDownloading && !model.file_exists && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 px-2"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDownload(model)
                            }}
                          >
                            <Download className="h-3 w-3 mr-1" />
                            Download
                          </Button>
                        )}
                        
                        {!isDownloading && model.file_exists && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 px-2"
                            onClick={(e) => {
                              e.stopPropagation()
                              handleDelete(model)
                            }}
                          >
                            <Trash2 className="h-3 w-3 mr-1" />
                            Delete
                          </Button>
                        )}
                      </div>
                      
                      {isDownloading && progress && progress.status === 'downloading' && (
                        <div className="space-y-1">
                          <div className="relative h-2 w-full overflow-hidden rounded-full bg-primary/20">
                            <div
                              className="h-full bg-primary transition-all"
                              style={{ width: `${progress.progress || 0}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-xs text-muted-foreground">
                            <span>
                              {progress.download_speed || 'Calculating speed...'}
                            </span>
                            <span>
                              {Math.round(progress.progress)}% completed
                            </span>
                          </div>
                        </div>
                      )}
                      
                      {progress?.status === 'error' && (
                        <div className="text-xs text-red-500 bg-red-50 dark:bg-red-900/20 p-2 rounded">
                          Error: {progress.error}
                        </div>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )
            })
          )}
        </div>
        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button 
            onClick={() => setOpen(false)} 
            disabled={isOllamaCloud ? !internalSelectedOllama : (!internalSelected || !internalSelected.file_exists)}
          >
            Confirm Selection
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
