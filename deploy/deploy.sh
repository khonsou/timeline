#!/usr/bin/env bash
set -Eeuo pipefail

# 拾光轴 Timeline Board：前后端镜像构建、推送与 K8s 更新总入口。
# 用法：bash deploy/deploy.sh [test|prod] [1|2]；1 更新后端，2 更新前端。

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
DEPLOY_DIR="$ROOT_DIR/deploy"
ENVIRONMENT="${1:-test}"
if [[ "$ENVIRONMENT" == "test" || "$ENVIRONMENT" == "prod" ]]; then
  shift
else
  ENVIRONMENT="test"
fi

case "$ENVIRONMENT" in
  test)
    K8S_DIR="$DEPLOY_DIR/k8s/test"
    K8S_NAMESPACE="${K8S_NAMESPACE:-angrymiao-test}"
    APP_BASE_PATH="/test"
    BOARD_PVC_NAME="timeline-board-test-data"
    ;;
  prod)
    K8S_DIR="$DEPLOY_DIR/k8s/prod"
    K8S_NAMESPACE="${K8S_NAMESPACE:-angrymiao-prod}"
    APP_BASE_PATH="/aVoSaywtHjXCA"
    BOARD_PVC_NAME="timeline-board-data"
    ;;
esac

K8S_CONTEXT="${K8S_CONTEXT:-kubernetes-admin-c72d7454d43804ccc87327b729e670ba4}"
REGISTRY="${REGISTRY:-registry.cn-shenzhen.aliyuncs.com/angrymiao}"
IMAGE_REPO="${IMAGE_REPO:-timeline}"
APP_HOST="${TIMELINE_HOST:-timeline.angrymiao.com}"
BOARD_SECRET_NAME="timeline-board-secret"
IMAGE_PULL_SECRET="aliyun-reg-secret"
TLS_SECRET_NAME="am-tls"
NAS_CSI_DRIVER="nasplugin.csi.alibabacloud.com"

if [[ -n "${IMAGE_TAG:-}" ]]; then
  RELEASE_TAG="$IMAGE_TAG"
else
  RELEASE_TAG="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
  WORKTREE_STATE="$(git -C "$ROOT_DIR" status --porcelain --untracked-files=all 2>/dev/null || true)"
  if [[ -n "$WORKTREE_STATE" ]]; then
    RELEASE_TAG="${RELEASE_TAG}-dirty-$(date +%Y%m%d%H%M%S)"
  fi
fi

API_IMAGE="$REGISTRY/$IMAGE_REPO:backend-$ENVIRONMENT-$RELEASE_TAG"
WEB_IMAGE="$REGISTRY/$IMAGE_REPO:frontend-$ENVIRONMENT-$RELEASE_TAG"

API_DEPLOYMENT="timeline-backend-deployment"
WEB_DEPLOYMENT="timeline-frontend-deployment"
DOCKER_BIN=""
KUBECTL_BIN=""
NODE_BIN=""

die() {
  echo "[timeline] 错误：$*" >&2
  exit 1
}

warn() {
  echo "[timeline] 警告：$*" >&2
}

resolve_command() {
  local name="$1"
  if command -v "${name}.exe" >/dev/null 2>&1; then
    printf '%s\n' "${name}.exe"
    return
  fi
  if command -v "$name" >/dev/null 2>&1; then
    printf '%s\n' "$name"
    return
  fi
  die "找不到命令：$name（也未找到 ${name}.exe）"
}

kube() {
  "$KUBECTL_BIN" --context "$K8S_CONTEXT" "$@"
}

docker_path() {
  local path_value="$1"
  if [[ "$DOCKER_BIN" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    wslpath -w "$path_value"
  else
    printf '%s\n' "$path_value"
  fi
}

render_manifest() {
  local file="$1"
  sed \
    -e "s|__API_IMAGE__|$API_IMAGE|g" \
    -e "s|__WEB_IMAGE__|$WEB_IMAGE|g" \
    -e "s|__APP_HOST__|$APP_HOST|g" \
    -e "s|__BASE_PATH__|$APP_BASE_PATH|g" \
    -e "s|__NAMESPACE__|$K8S_NAMESPACE|g" \
    "$file"
}

copy_secret() {
  local name="$1"
  if kube get secret "$name" -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
    return
  fi
  kube get secret "$name" -n angrymiao-test -o json \
    | "$NODE_BIN" -e 'const namespace=process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const x=JSON.parse(s);process.stdout.write(JSON.stringify({apiVersion:"v1",kind:"Secret",metadata:{name:x.metadata.name,namespace},type:x.type,data:x.data}))})' "$K8S_NAMESPACE" \
    | kube apply -f - >/dev/null
  echo "[timeline] 已从 test 复制 Secret：$name"
}

check_prod_volume_not_test_bound() {
  [[ "$ENVIRONMENT" == "prod" ]] || return 0
  local claim
  claim="$(kube get pv timeline-board-nas -o jsonpath='{.spec.claimRef.namespace}/{.spec.claimRef.name}')"
  [[ "$claim" == "/" ]] && claim=""
  [[ -z "$claim" || "$claim" == "$K8S_NAMESPACE/timeline-board-data" ]] \
    || die "生产 NAS 卷仍绑定到 $claim；先停 test 后端并完成 PVC 切换"
}

check_prod_volume_bound() {
  [[ "$ENVIRONMENT" == "prod" ]] || return 0
  local phase claim
  phase="$(kube get pvc timeline-board-data -n "$K8S_NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  claim="$(kube get pv timeline-board-nas -o jsonpath='{.spec.claimRef.namespace}/{.spec.claimRef.name}')"
  [[ "$phase" == "Bound" && "$claim" == "$K8S_NAMESPACE/timeline-board-data" ]] \
    || die "生产 PVC 尚未绑定原数据卷；拒绝发布生产前端"
}

apply_manifest() {
  local file="$1"
  render_manifest "$file" | kube apply -n "$K8S_NAMESPACE" -f -
}

dry_run_manifest() {
  local file="$1"
  render_manifest "$file" | kube apply --dry-run=server -n "$K8S_NAMESPACE" -f - >/dev/null
}

check_common_prerequisites() {
  DOCKER_BIN="$(resolve_command docker)"
  KUBECTL_BIN="$(resolve_command kubectl)"
  NODE_BIN="$(resolve_command node)"

  kube config get-contexts "$K8S_CONTEXT" >/dev/null 2>&1 \
    || die "Kubernetes context 不存在：$K8S_CONTEXT（可通过 K8S_CONTEXT 覆盖）"
  kube config current-context
  check_prod_volume_not_test_bound
  kube create namespace "$K8S_NAMESPACE" --dry-run=client -o yaml | kube apply -f - >/dev/null
  if [[ "$ENVIRONMENT" == "prod" ]]; then
    copy_secret "$IMAGE_PULL_SECRET"
    copy_secret "$TLS_SECRET_NAME"
  fi
  kube get secret "$IMAGE_PULL_SECRET" -n "$K8S_NAMESPACE" >/dev/null \
    || die "镜像拉取 Secret 不存在：$K8S_NAMESPACE/$IMAGE_PULL_SECRET"
  kube get secret "$TLS_SECRET_NAME" -n "$K8S_NAMESPACE" >/dev/null \
    || die "TLS Secret 不存在：$K8S_NAMESPACE/$TLS_SECRET_NAME"

  [[ "$APP_BASE_PATH" == /* ]] || die "应用路径必须以 / 开头"
  [[ "$APP_HOST" != */* ]] || die "TIMELINE_HOST 只能填写域名，不要包含路径"

  echo "[timeline] namespace: $K8S_NAMESPACE"
  echo "[timeline] host: https://$APP_HOST$APP_BASE_PATH"
  echo "[timeline] api image: $API_IMAGE"
  echo "[timeline] web image: $WEB_IMAGE"
}

ensure_board_secret() {
  if kube get secret "$BOARD_SECRET_NAME" -n "$K8S_NAMESPACE" >/dev/null 2>&1; then
    kube get secret "$BOARD_SECRET_NAME" -n "$K8S_NAMESPACE" \
      -o jsonpath='{.data.BOARD_SECRET}' | grep -q . \
      || die "已有 Secret 缺少 BOARD_SECRET：$K8S_NAMESPACE/$BOARD_SECRET_NAME"
    return
  fi

  if [[ "$ENVIRONMENT" == "prod" ]]; then
    copy_secret "$BOARD_SECRET_NAME"
    return
  fi

  [[ -n "${BOARD_SECRET:-}" ]] \
    || die "首次部署需要设置 BOARD_SECRET 环境变量；该值不会写入仓库"

  kube create secret generic "$BOARD_SECRET_NAME" \
    -n "$K8S_NAMESPACE" \
    --from-literal="BOARD_SECRET=$BOARD_SECRET" \
    --dry-run=client -o yaml | kube apply -f - >/dev/null
  echo "[timeline] 已创建 K8s Secret：$K8S_NAMESPACE/$BOARD_SECRET_NAME"
}

validate_backend_manifests() {
  dry_run_manifest "$K8S_DIR/pvc.yaml"
  dry_run_manifest "$K8S_DIR/backend/deployment.yaml"
  dry_run_manifest "$K8S_DIR/backend/service.yaml"
}

validate_frontend_manifests() {
  dry_run_manifest "$K8S_DIR/frontend/deployment.yaml"
  dry_run_manifest "$K8S_DIR/frontend/service.yaml"
}

validate_ingress_manifest() {
  dry_run_manifest "$K8S_DIR/ingress.yaml"
}

build_push_backend() {
  echo "[timeline] 步骤 1/3：构建服务端镜像"
  "$DOCKER_BIN" build \
    -f "$(docker_path "$DEPLOY_DIR/docker/backend.Dockerfile")" \
    -t "$API_IMAGE" \
    "$(docker_path "$ROOT_DIR")"

  echo "[timeline] 步骤 2/3：推送服务端镜像"
  "$DOCKER_BIN" push "$API_IMAGE"
}

build_push_frontend() {
  echo "[timeline] 步骤 1/3：构建客户端镜像"
  "$DOCKER_BIN" build \
    -f "$(docker_path "$DEPLOY_DIR/docker/frontend.Dockerfile")" \
    --build-arg "BASE_PATH=$APP_BASE_PATH" \
    -t "$WEB_IMAGE" \
    "$(docker_path "$ROOT_DIR")"

  echo "[timeline] 步骤 2/3：推送客户端镜像"
  "$DOCKER_BIN" push "$WEB_IMAGE"
}

update_backend() {
  kube get csidriver "$NAS_CSI_DRIVER" >/dev/null \
    || die "NAS CSI Driver 不存在：$NAS_CSI_DRIVER"
  ensure_board_secret
  validate_backend_manifests
  validate_ingress_manifest
  build_push_backend

  echo "[timeline] 步骤 3/3：更新服务端 K8s 资源"
  apply_manifest "$K8S_DIR/pvc.yaml"
  apply_manifest "$K8S_DIR/backend/service.yaml"
  apply_manifest "$K8S_DIR/backend/deployment.yaml"
  apply_manifest "$K8S_DIR/ingress.yaml"
  kube rollout status "deployment/$API_DEPLOYMENT" -n "$K8S_NAMESPACE" --timeout=300s
  kube get pod,svc -n "$K8S_NAMESPACE" -l 'app=timeline-backend' -o wide
  kube get pvc "$BOARD_PVC_NAME" -n "$K8S_NAMESPACE" -o wide
}

update_frontend() {
  check_prod_volume_bound
  validate_frontend_manifests
  validate_ingress_manifest
  build_push_frontend

  echo "[timeline] 步骤 3/3：更新客户端 K8s 资源"
  apply_manifest "$K8S_DIR/frontend/service.yaml"
  apply_manifest "$K8S_DIR/frontend/deployment.yaml"
  apply_manifest "$K8S_DIR/ingress.yaml"
  kube rollout status "deployment/$WEB_DEPLOYMENT" -n "$K8S_NAMESPACE" --timeout=300s
  kube get pod,svc -n "$K8S_NAMESPACE" -l 'app=timeline-frontend' -o wide
}

main() {
  check_common_prerequisites
  echo
  echo "========================================"
  echo "  拾光轴 Timeline Board 发布（$ENVIRONMENT）"
  echo "========================================"
  echo "1) 更新服务端"
  echo "2) 更新客户端"
  echo
  choice="${1:-}"
  if [[ -z "$choice" ]]; then
    read -r -p "请选择操作 (1-2): " choice
  fi

  case "$choice" in
    1)
      update_backend
      ;;
    2)
      update_frontend
      ;;
    *)
      die "无效选项，请输入 1 或 2"
      ;;
  esac

  echo
  echo "[timeline] 发布完成：$choice"
  echo "[timeline] 访问地址：https://$APP_HOST$APP_BASE_PATH"
}

main "$@"
