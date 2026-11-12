export BUILD_IMG_TAG=0.0.0002
sh .deploy/check-docker.sh

cp .deploy/Dockerfile ./

docker buildx build \
   --platform=linux/amd64 \
   --tag ccr.ccs.tencentyun.com/mythosma/arena-shot:$BUILD_IMG_TAG \
   --push -t ccr.ccs.tencentyun.com/mythosma/arena-shot:$BUILD_IMG_TAG .

rm -f Dockerfile
