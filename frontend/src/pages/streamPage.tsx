import { Stream } from "@/components/stream"
import { Label } from "@/components/ui/label"

function StreamPage() {


    return (
        <div className="flex h-full flex-col gap-4 overflow-y-auto p-5">
            <Label className="text-sm text-muted-foreground">This is still an experiemental feature.</Label> 
            <Stream></Stream>
        </div>
    )
  }
  
  export default StreamPage