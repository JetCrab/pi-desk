use super::*;

async fn healthy_registration(fixture: &Fixture) -> Result<OpenTunnelResponse, String> {
    let opened = fixture.open("healthy-b", None).await?;
    fixture.install(&opened).await?;
    fixture.ready(&opened.tunnel_id).await?;
    Ok(opened)
}

async fn offline_registration(
    fixture: &Fixture,
) -> Result<(OpenTunnelRequest, OpenTunnelResponse, Instant), String> {
    let request = OpenTunnelRequest {
        request_id: "offline-a".to_owned(),
        provider_id: pi_desk_tunnel_common::runtime::provider_id(&"03".repeat(32))?,
        port: 3001,
        public_port: Some(unused_port().await?),
    };
    let opened = fixture.registry.open(request.clone()).await.map_err(text)?;
    let lease_baseline = Instant::now();
    let (reply, result) = oneshot::channel();
    fixture
        .registry
        .commands
        .send(Command::ProbeStarted(opened.tunnel_id.clone(), reply))
        .await
        .map_err(text)?;
    let mut started = result.await.map_err(text)?.ok_or("缺少离线登记")?;
    timeout(Duration::from_secs(1), started.wait_for(|started| *started))
        .await
        .map_err(|_| "离线探测未开始".to_owned())?
        .map_err(text)?;
    Ok((request, opened, lease_baseline))
}

async fn removed(fixture: &Fixture, id: &str) -> Result<(), String> {
    timeout(Duration::from_secs(1), async {
        let mut poll = tokio::time::interval(Duration::from_millis(5));
        loop {
            match fixture.registry.status(id).await {
                Err(TunnelError::NotFound) => return Ok(()),
                Err(error) => return Err(text(error)),
                Ok(_) => {
                    poll.tick().await;
                }
            }
        }
    })
    .await
    .map_err(|_| "离线登记清理阻塞了命令循环".to_owned())?
}

async fn responsive(fixture: &Fixture, healthy: &OpenTunnelResponse) -> Result<(), String> {
    timeout(Duration::from_secs(1), async {
        let status = fixture
            .registry
            .status(&healthy.tunnel_id)
            .await
            .map_err(text)?;
        check(status.status == TunnelStatus::Ready, "正常B不再ready")?;
        let resolved = fixture.resolve().await.map_err(text)?;
        check(resolved.tunnel_id == healthy.tunnel_id, "正常B解析结果改变")
    })
    .await
    .map_err(|_| "离线A清理阻塞正常B的status/resolve".to_owned())?
}

async fn completed<T: Send + 'static>(
    operations: &mut JoinSet<Result<T, TunnelError>>,
) -> Result<T, String> {
    timeout(Duration::from_secs(12), operations.join_next())
        .await
        .map_err(|_| "离线登记资源回收未结束".to_owned())?
        .ok_or("缺少待完成操作")?
        .map_err(text)?
        .map_err(text)
}

#[tokio::test]
async fn offline_close_keeps_other_registration_responsive_until_cleanup_is_joined() {
    let fixture = Fixture::start().await.expect("应准备真实relay fixture");
    let result = async {
        let healthy = healthy_registration(&fixture).await?;
        let (request, offline, _) = offline_registration(&fixture).await?;
        let mut operations = JoinSet::new();
        for _ in 0..2 {
            let registry = fixture.registry.clone();
            let id = offline.tunnel_id.clone();
            operations.spawn(async move { registry.close(&id).await });
        }
        removed(&fixture, &offline.tunnel_id).await?;
        responsive(&fixture, &healthy).await?;
        check(
            operations.try_join_next().is_none(),
            "close在离线探测结束前提前回复",
        )?;
        completed(&mut operations).await?;
        completed(&mut operations).await?;
        std::net::TcpListener::bind(("0.0.0.0", request.public_port.ok_or("缺少公网端口")?))
            .map_err(text)?;
        responsive(&fixture, &healthy).await?;
        Ok::<_, String>(())
    }
    .await;
    fixture.close().await;
    result.expect("离线close不应阻塞其他登记");
}

#[tokio::test]
async fn offline_replacement_waits_for_same_port_without_blocking_other_registration() {
    let fixture = Fixture::start().await.expect("应准备真实relay fixture");
    let result = async {
        let healthy = healthy_registration(&fixture).await?;
        let (mut request, offline, _) = offline_registration(&fixture).await?;
        request.request_id = "replace-offline-a".to_owned();
        let registry = fixture.registry.clone();
        let mut operations = JoinSet::new();
        operations.spawn(async move { registry.open(request).await });
        removed(&fixture, &offline.tunnel_id).await?;
        responsive(&fixture, &healthy).await?;
        check(
            operations.try_join_next().is_none(),
            "同端口替换未等待旧探测回收",
        )?;
        let replacement = completed(&mut operations).await?;
        check(
            replacement.tunnel_id != offline.tunnel_id
                && replacement.public_addr == offline.public_addr,
            "同端口替换结果不正确",
        )?;
        responsive(&fixture, &healthy).await?;
        Ok::<_, String>(())
    }
    .await;
    fixture.close().await;
    result.expect("离线替换只应等待该项清理");
}

#[tokio::test]
async fn offline_expiry_sweeps_without_blocking_other_registration() {
    let fixture = Fixture::start().await.expect("应准备真实relay fixture");
    let result = async {
        let healthy = healthy_registration(&fixture).await?;
        let (request, offline, baseline) = offline_registration(&fixture).await?;
        responsive(&fixture, &healthy).await?;
        let (reply, result) = oneshot::channel();
        fixture
            .registry
            .commands
            .send(Command::Expire(baseline + LEASE_DURATION, reply))
            .await
            .map_err(text)?;
        timeout(Duration::from_secs(1), result)
            .await
            .map_err(|_| "过期清扫等待了离线探测".to_owned())?
            .map_err(text)?;
        removed(&fixture, &offline.tunnel_id).await?;
        responsive(&fixture, &healthy).await?;
        let registry = fixture.registry.clone();
        let id = offline.tunnel_id;
        let mut operations = JoinSet::new();
        operations.spawn(async move { registry.close(&id).await });
        responsive(&fixture, &healthy).await?;
        check(
            operations.try_join_next().is_none(),
            "过期登记清理未完成却提前回复close",
        )?;
        completed(&mut operations).await?;
        std::net::TcpListener::bind(("0.0.0.0", request.public_port.ok_or("缺少公网端口")?))
            .map_err(text)?;
        responsive(&fixture, &healthy).await?;
        Ok::<_, String>(())
    }
    .await;
    fixture.close().await;
    result.expect("离线过期不应阻塞续租和查询");
}

#[tokio::test]
async fn shutdown_joins_pending_offline_release_and_releases_public_port() {
    let fixture = Fixture::start().await.expect("应准备真实relay fixture");
    let result = async {
        let healthy = healthy_registration(&fixture).await?;
        let (request, offline, _) = offline_registration(&fixture).await?;
        let registry = fixture.registry.clone();
        let id = offline.tunnel_id.clone();
        let mut operations = JoinSet::new();
        operations.spawn(async move { registry.close(&id).await });
        removed(&fixture, &offline.tunnel_id).await?;
        responsive(&fixture, &healthy).await?;
        check(
            operations.try_join_next().is_none(),
            "缺少待join的离线回收任务",
        )?;
        timeout(Duration::from_secs(5), fixture.registry.shutdown())
            .await
            .map_err(|_| "退出未取消并join离线探测".to_owned())?;
        completed(&mut operations).await?;
        std::net::TcpListener::bind(("0.0.0.0", request.public_port.ok_or("缺少公网端口")?))
            .map_err(text)?;
        Ok::<_, String>(())
    }
    .await;
    fixture.close().await;
    result.expect("退出应join全部pending回收任务");
}
