import { CharacterRender } from "@/components/character-render"

interface CharacterPageProps {
    isActive: boolean
}

function CharacterPage({ isActive }: CharacterPageProps) {
    return (
        <div className="w-full h-full">
            <CharacterRender isActive={isActive} />
        </div>
    )
}

export default CharacterPage