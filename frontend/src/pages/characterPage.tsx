import { CharacterRender } from "@/components/character-render"
import { CharacterCaption } from "@/components/character-caption"

interface CharacterPageProps {
    isActive: boolean
}

function CharacterPage({ isActive }: CharacterPageProps) {
    return (
        <div className="relative w-full h-full">
            <CharacterRender isActive={isActive} />
            <CharacterCaption visible={isActive} />
        </div>
    )
}

export default CharacterPage
