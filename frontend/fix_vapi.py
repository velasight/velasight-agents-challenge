@"
import re
content = open('src/hooks/useVapi.js', encoding='utf-8', errors='ignore').read()

old = """            try {
            const result = await handleVapiToolCall(funcName, enrichedArgs)
            if (funcName === 'get_property_analysis' && result.summary) { useExploreStore.setState({ voiceResponse: result.summary }); }"""

new = """            try {
              const result = await handleVapiToolCall(funcName, enrichedArgs)
              if (funcName === 'get_property_analysis' && result.summary) { useExploreStore.setState({ voiceResponse: result.summary }); }"""

if old in content:
    content = content.replace(old, new)
    print('Fixed try block indentation')
else:
    print('Pattern not found')
    print(repr(content[content.find('try {'):content.find('try {')+200]))

open('src/hooks/useVapi.js', 'w', encoding='utf-8').write(content)
"@ | Set-Content "fix_vapi.py"