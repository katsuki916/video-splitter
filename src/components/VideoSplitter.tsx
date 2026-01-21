import { useState, useRef, useCallback } from 'react'
import { Upload, Check, Download, RefreshCw, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { cn, formatDuration, formatFileSize, getBaseName } from '@/lib/utils'

const API_BASE_URL = 'https://video-splitter-api.onrender.com'
const SEGMENT_DURATION = 120
const BROWSER_MAX_SIZE = 300 * 1024 * 1024
const SERVER_MAX_SIZE = 5 * 1024 * 1024 * 1024

type Status = 'idle' | 'loading' | 'ready' | 'processing' | 'completed' | 'error'

interface SplitFile {
  name: string
  partNumber: number
  downloadUrl?: string
  url?: string
}

export function VideoSplitter() {
  const [status, setStatus] = useState<Status>('idle')
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressText, setProgressText] = useState('')
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [videoDuration, setVideoDuration] = useState(0)
  const [splitFiles, setSplitFiles] = useState<SplitFile[]>([])
  const [useServerProcessing, setUseServerProcessing] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const currentJobIdRef = useRef<string | null>(null)

  const getVideoDuration = useCallback((file: File): Promise<number> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.onloadedmetadata = () => {
        URL.revokeObjectURL(video.src)
        resolve(video.duration)
      }
      video.onerror = () => {
        URL.revokeObjectURL(video.src)
        reject(new Error('動画の読み込みに失敗しました'))
      }
      video.src = URL.createObjectURL(file)
    })
  }, [])

  const handleFileSelect = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setError(null)
    setWarning(null)
    setSplitFiles([])
    setProgress(0)

    if (!file.type.startsWith('video/')) {
      setError('動画ファイルを選択してください')
      setStatus('error')
      return
    }

    if (file.size > SERVER_MAX_SIZE) {
      setError(`ファイルサイズが大きすぎます（${formatFileSize(file.size)}）。\n5GB以下の動画に対応しています。`)
      setStatus('error')
      return
    }

    setSelectedFile(file)
    const shouldUseServer = file.size > BROWSER_MAX_SIZE
    setUseServerProcessing(shouldUseServer)

    try {
      setStatus('loading')
      const duration = await getVideoDuration(file)
      setVideoDuration(duration)

      if (duration <= SEGMENT_DURATION) {
        setWarning('この動画は2分以下のため、分割不要です')
      } else if (shouldUseServer) {
        setWarning('大きなファイルのため、サーバーで処理します。\nアップロードに時間がかかる場合があります。')
      }

      setStatus('ready')
    } catch {
      setError('動画の読み込みに失敗しました。別の動画を試してください。')
      setStatus('error')
    }
  }, [getVideoDuration])

  const splitVideoServer = useCallback(async () => {
    if (!selectedFile) return

    setStatus('processing')
    setProgressText('アップロード中...')
    setProgress(0)

    try {
      const formData = new FormData()
      formData.append('video', selectedFile)

      const uploadResponse = await fetch(`${API_BASE_URL}/split`, {
        method: 'POST',
        body: formData,
      })

      if (!uploadResponse.ok) {
        throw new Error('アップロードに失敗しました')
      }

      const { jobId } = await uploadResponse.json()
      currentJobIdRef.current = jobId

      setProgressText('処理中...')

      while (true) {
        await new Promise(resolve => setTimeout(resolve, 2000))

        const statusResponse = await fetch(`${API_BASE_URL}/status/${jobId}`)
        if (!statusResponse.ok) {
          throw new Error('状態の取得に失敗しました')
        }

        const jobStatus = await statusResponse.json()

        if (jobStatus.status === 'error') {
          throw new Error(jobStatus.error || '処理中にエラーが発生しました')
        }

        setProgress(jobStatus.progress)
        setProgressText(`処理中... ${jobStatus.progress}%`)

        if (jobStatus.status === 'completed') {
          setSplitFiles(jobStatus.files.map((f: { name: string; partNumber: number }) => ({
            name: f.name,
            partNumber: f.partNumber,
            downloadUrl: `${API_BASE_URL}/download/${jobId}/${f.partNumber}`,
          })))
          setStatus('completed')
          return
        }
      }
    } catch (err) {
      setError(`サーバー処理エラー: ${err instanceof Error ? err.message : '不明なエラー'}`)
      setStatus('error')
    }
  }, [selectedFile])

  const splitVideoBrowser = useCallback(async () => {
    if (!selectedFile) return

    setStatus('processing')
    setProgressText('ファイルを読み込み中...')
    setProgress(0)

    try {
      const { createFFmpeg, fetchFile } = (window as unknown as { FFmpeg: { createFFmpeg: (opts: { log: boolean }) => unknown; fetchFile: (file: File) => Promise<Uint8Array> } }).FFmpeg
      const ffmpeg = createFFmpeg({ log: true }) as {
        load: () => Promise<void>;
        FS: (cmd: string, ...args: unknown[]) => Uint8Array;
        run: (...args: string[]) => Promise<void>;
      }
      await ffmpeg.load()

      const baseName = getBaseName(selectedFile.name)
      const numParts = Math.ceil(videoDuration / SEGMENT_DURATION)

      ffmpeg.FS('writeFile', 'input.mp4', await fetchFile(selectedFile))

      const files: SplitFile[] = []

      for (let i = 0; i < numParts; i++) {
        const startTime = i * SEGMENT_DURATION
        const outputName = `${baseName}_part${i + 1}.mp4`
        const outputFileName = `output_${i}.mp4`

        setProgressText(`分割中... (${i + 1}/${numParts})`)
        setProgress(((i + 0.5) / numParts) * 100)

        await ffmpeg.run(
          '-i', 'input.mp4',
          '-ss', startTime.toString(),
          '-t', SEGMENT_DURATION.toString(),
          '-c', 'copy',
          '-avoid_negative_ts', 'make_zero',
          outputFileName
        )

        const data = ffmpeg.FS('readFile', outputFileName) as Uint8Array
        const blob = new Blob([new Uint8Array(data)], { type: 'video/mp4' })
        const url = URL.createObjectURL(blob)

        files.push({
          name: outputName,
          partNumber: i + 1,
          url,
        })

        ffmpeg.FS('unlink', outputFileName)
        setProgress(((i + 1) / numParts) * 100)
      }

      ffmpeg.FS('unlink', 'input.mp4')
      setSplitFiles(files)
      setStatus('completed')
    } catch (err) {
      setError(`処理エラー: ${err instanceof Error ? err.message : '不明なエラー'}`)
      setStatus('error')
    }
  }, [selectedFile, videoDuration])

  const handleSplit = useCallback(() => {
    if (useServerProcessing) {
      splitVideoServer()
    } else {
      splitVideoBrowser()
    }
  }, [useServerProcessing, splitVideoServer, splitVideoBrowser])

  const handleDownload = useCallback((file: SplitFile) => {
    const a = document.createElement('a')
    a.href = file.downloadUrl || file.url || ''
    a.download = file.name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }, [])

  const handleDownloadAll = useCallback(() => {
    splitFiles.forEach((file, index) => {
      setTimeout(() => handleDownload(file), index * 1000)
    })
  }, [splitFiles, handleDownload])

  const handleReset = useCallback(() => {
    if (currentJobIdRef.current) {
      fetch(`${API_BASE_URL}/job/${currentJobIdRef.current}`, { method: 'DELETE' }).catch(() => {})
      currentJobIdRef.current = null
    }
    setStatus('idle')
    setError(null)
    setWarning(null)
    setSelectedFile(null)
    setVideoDuration(0)
    setSplitFiles([])
    setProgress(0)
    setProgressText('')
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }, [])

  const numParts = Math.ceil(videoDuration / SEGMENT_DURATION)

  return (
    <div className="min-h-dvh flex flex-col">
      <header className="py-6 text-center">
        <h1 className="text-2xl font-semibold text-balance">動画を2分で分割</h1>
      </header>

      <main className="flex-1 px-4 pb-8 max-w-lg mx-auto w-full space-y-4">
        {/* ファイル選択 */}
        <div className="flex justify-center">
          <Button
            onClick={() => fileInputRef.current?.click()}
            disabled={status === 'processing'}
            className="w-full max-w-[280px]"
            aria-label="動画ファイルを選択"
          >
            <Upload className="size-5 mr-2" />
            動画を選択
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileSelect}
            className="sr-only"
          />
        </div>

        {/* 動画情報 */}
        {selectedFile && status !== 'idle' && status !== 'error' && (
          <Card>
            <CardContent className="p-4 text-center space-y-1">
              <p className="font-semibold break-all">
                {selectedFile.name} ({formatFileSize(selectedFile.size)})
              </p>
              <p className="text-muted-foreground text-sm">
                長さ: {formatDuration(videoDuration)}
              </p>
              {videoDuration > SEGMENT_DURATION && (
                <p className="text-primary font-medium text-sm tabular-nums">
                  → {numParts}本に分割されます
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* 警告 */}
        {warning && (
          <Alert variant="warning">
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        )}

        {/* エラー */}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* 分割開始ボタン */}
        {status === 'ready' && videoDuration > SEGMENT_DURATION && (
          <div className="flex justify-center">
            <Button onClick={handleSplit} className="w-full max-w-[280px]">
              分割開始
            </Button>
          </div>
        )}

        {/* プログレス */}
        {status === 'processing' && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <Progress value={progress} />
              <p className="text-center text-muted-foreground text-sm tabular-nums">
                {progressText}
              </p>
            </CardContent>
          </Card>
        )}

        {/* 結果 */}
        {status === 'completed' && (
          <div className="space-y-4">
            <p className="text-center text-success font-semibold">分割完了</p>
            <ul className="space-y-2">
              {splitFiles.map((file) => (
                <li key={file.partNumber}>
                  <Card>
                    <CardContent className="p-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-2 min-w-0">
                        <Check className="size-5 text-success shrink-0" />
                        <span className="text-sm font-medium truncate">{file.name}</span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleDownload(file)}
                        aria-label={`${file.name}を保存`}
                      >
                        <Download className="size-4 mr-1" />
                        保存
                      </Button>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
            <div className="flex justify-center">
              <Button variant="secondary" onClick={handleDownloadAll} className="w-full max-w-[280px]">
                全部まとめて保存
              </Button>
            </div>
          </div>
        )}

        {/* リトライ/リセット */}
        {(status === 'error' || status === 'completed') && (
          <div className="flex justify-center">
            <Button variant="ghost" onClick={handleReset} className={cn(status === 'completed' && 'mt-2')}>
              <RefreshCw className="size-4 mr-2" />
              やり直す
            </Button>
          </div>
        )}

        {/* ローディング */}
        {status === 'loading' && (
          <div className="flex justify-center py-8">
            <Loader2 className="size-8 text-primary animate-spin" />
          </div>
        )}
      </main>
    </div>
  )
}
