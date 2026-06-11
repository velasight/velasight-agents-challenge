FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json .
RUN npm install

COPY . .

# Build args injected at build time by Cloud Build
ARG VITE_MAPBOX_TOKEN
ARG VITE_API_URL
ARG VITE_VAPI_PUBLIC_KEY
ARG VITE_VAPI_ASSISTANT_ID

ENV VITE_MAPBOX_TOKEN=$VITE_MAPBOX_TOKEN
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_VAPI_PUBLIC_KEY=$VITE_VAPI_PUBLIC_KEY
ENV VITE_VAPI_ASSISTANT_ID=$VITE_VAPI_ASSISTANT_ID

RUN npm run build

# ── Production stage ──────────────────────────────────────────

FROM nginx:alpine

# PWA needs correct MIME types and headers
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
