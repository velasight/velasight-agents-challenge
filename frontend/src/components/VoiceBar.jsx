import { useExploreStore } from '../store'
import { useVapi } from '../hooks/useVapi'

export default function VoiceBar() {
  const { vapiConnected } = useExploreStore()
  const { startCall, stopCall } = useVapi()

  return (
    <button 
      onClick={vapiConnected ? stopCall : startCall}
      style={{
        width: '60px', height: '60px', borderRadius: '50%', flexShrink: 0,
        background: vapiConnected ? 'rgba(248,113,113,0.15)' : 'rgba(79, 195, 247, 0.1)',
        border: `2px solid ${vapiConnected ? '#F87171' : 'var(--accent-teal)'}`,
        color: vapiConnected ? '#F87171' : 'var(--accent-teal)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        cursor: 'pointer', transition: 'all 0.3s ease',
        boxShadow: vapiConnected ? '0 0 20px rgba(248,113,113,0.3)' : '0 0 20px rgba(79, 195, 247, 0.2)',
        fontSize: '24px'
      }}
    >
      {vapiConnected ? '⏹' : '🎤'}
    </button>
  )
}