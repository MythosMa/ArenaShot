res=`docker ps`
echo "res: $res"
if [[ $res ]]
then
  echo "Docker is running"
else
  echo "Docker is not running, starting docker..."
  open /Applications/Docker.app
  sleep 30
fi