define(["TFS/WorkItemTracking/Services", "TFS/WorkItemTracking/RestClient", "TFS/Work/RestClient", "q", "VSS/Controls", "VSS/Controls/StatusIndicator", "VSS/Controls/Dialogs"],
    function (_WorkItemServices, _WorkItemRestClient, workRestClient, Q, Controls, StatusIndicator, Dialogs) {

        var ctx = null;

        function getWorkItemFormService() {
            return _WorkItemServices.WorkItemFormService.getService();
        }

        function getTemplates(workItemTypes) {

            var requests = []
            var witClient = _WorkItemRestClient.getClient();

            workItemTypes.forEach(function (workItemType) {

                var request = witClient.getTemplates(ctx.project.id, ctx.team.id, workItemType);
                requests.push(request);
            }, this);

            return Q.all(requests)
                .then(function (templateTypes) {

                    var templates = [];
                    templateTypes.forEach(function (templateType) {
                        if (templateType.length > 0) {

                            templateType.forEach(function (element) {
                                templates.push(element)
                            }, this);
                        }
                    }, this);
                    return templates;
                });
        }

        function getTemplate(id) {
            var witClient = _WorkItemRestClient.getClient();
            return witClient.getTemplate(ctx.project.id, ctx.team.id, id);
        }

        function IsPropertyValid(taskTemplate, key) {
            if (taskTemplate.fields.hasOwnProperty(key) == false) {
                return false;
            }
            if (key.indexOf('System.Tags') >= 0) { //not supporting tags for now
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@me') { //current identity is handled later
                return false;
            }
            if (taskTemplate.fields[key].toLowerCase() == '@currentiteration') { //current iteration is handled later
                return false;
            }

            return true;
        }

        function replaceReferenceToParentField(fieldValue, currentWorkItem) {
            var filters = fieldValue.match(/[^{\}]+(?=})/g);
            if (filters) {
                for (var i = 0; i < filters.length; i++) {
                    var parentField = filters[i];
                    var parentValue = currentWorkItem[parentField];

                    fieldValue = fieldValue.replace('{' + parentField + '}', parentValue)
                }
            }
            return fieldValue;
        }

        function createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings) {
            var workItem = [];

            for (var key in taskTemplate.fields) {
                if (IsPropertyValid(taskTemplate, key)) {
                    //if field value is empty copies value from parent
                    if (taskTemplate.fields[key] == '') {
                        if (currentWorkItem[key] != null) {
                            workItem.push({ "op": "add", "path": "/fields/" + key, "value": currentWorkItem[key] })
                        }
                    }
                    else {
                        var fieldValue = taskTemplate.fields[key];
                        //check for references to parent fields - {fieldName}
                        fieldValue = replaceReferenceToParentField(fieldValue, currentWorkItem);

                        workItem.push({ "op": "add", "path": "/fields/" + key, "value": fieldValue })
                    }
                }
            }

            // if template has no title field copies value from parent
            if (taskTemplate.fields['System.Title'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.Title", "value": currentWorkItem['System.Title'] })

            // if template has no AreaPath field copies value from parent
            if (taskTemplate.fields['System.AreaPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.AreaPath", "value": currentWorkItem['System.AreaPath'] })

            // if template has no IterationPath field copies value from parent
            // check if IterationPath field value is @currentiteration
            if (taskTemplate.fields['System.IterationPath'] == null)
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": currentWorkItem['System.IterationPath'] })
            else if (taskTemplate.fields['System.IterationPath'].toLowerCase() == '@currentiteration')
                workItem.push({ "op": "add", "path": "/fields/System.IterationPath", "value": teamSettings.backlogIteration.name + teamSettings.defaultIteration.path })

            // check if AssignedTo field value is @me
            if (taskTemplate.fields['System.AssignedTo'] != null) {
                if (taskTemplate.fields['System.AssignedTo'].toLowerCase() == '@me') {
                    workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": ctx.user.uniqueName })
                }

                // if (taskTemplate.fields['System.AssignedTo'].toLowerCase() == '') {
                //     if (WIT['System.AssignedTo'] != null) {
                //         workItem.push({ "op": "add", "path": "/fields/System.AssignedTo", "value": currentWorkItem['System.AssignedTo'] })
                //     }
                // }
            }

            return workItem;
        }

        function createWorkItem(service, currentWorkItem, taskTemplate, teamSettings) {

            var witClient = _WorkItemRestClient.getClient();

            var newWorkItem = createWorkItemFromTemplate(currentWorkItem, taskTemplate, teamSettings);

            witClient.createWorkItem(newWorkItem, VSS.getWebContext().project.name, taskTemplate.workItemTypeName)
                .then(function (response) {
                    //Add relation
                    if (service != null) {
                        service.addWorkItemRelations([
                            {
                                rel: "System.LinkTypes.Hierarchy-Forward",
                                url: response.url,
                            }]);
                        //Save
                        service.beginSaveWorkItem(function (response) {
                            //WriteLog(" Saved");
                        }, function (error) {
                            ShowDialog(" Error saving: " + response);
                        });
                    } else {
                        //save using RestClient
                        var workItemId = currentWorkItem['System.Id']
                        var document = [{
                            op: "add",
                            path: '/relations/-',
                            value: {
                                rel: "System.LinkTypes.Hierarchy-Forward",
                                url: response.url,
                                attributes: {
                                    isLocked: false,
                                }
                            }
                        }];

                        witClient.updateWorkItem(document, workItemId)
                            .then(function (response) {
                                var a = response;
                                VSS.getService(VSS.ServiceIds.Navigation).then(function (navigationService) {
                                    navigationService.reload();
                                });
                            });
                    }
                });
        }

        function AddTasksOnForm(service) {

            service.getId()
                .then(function (workItemId) {
                    return AddTasks(workItemId, service)
                });
        }

        function AddTasksOnGrid(workItemId) {

            return AddTasks(workItemId, null)
        }

        function AddTasks(workItemId, service) {

            var witClient = _WorkItemRestClient.getClient();
            var workClient = workRestClient.getClient();

            var team = {
                projectId: ctx.project.id,
                teamId: ctx.team.id
            };

            workClient.getTeamSettings(team)
                .then(function (teamSettings) {
                    // Get the current values for a few of the common fields
                    witClient.getWorkItem(workItemId)
                        .then(function (value) {
                            var currentWorkItem = value.fields;

                            currentWorkItem['System.Id'] = workItemId;

                            var workItemType = currentWorkItem["System.WorkItemType"];
                            GetChildTypes(witClient, workItemType)
                                .then(function (childTypes) {
                                    if (childTypes == null)
                                        return;
                                    // get Templates
                                    getTemplates(childTypes)
                                        .then(function (response) {
                                            if (response.length == 0) {
                                                ShowDialog('No ' + childTypes + ' templates found. Please add ' + childTypes + ' templates for the project team.');
                                                return;
                                            }
                                            // Create children alphabetically.
                                            var templates = response.sort(SortTemplates);
                                            var chain = Q.when();
                                            templates.forEach(function (template) {
                                                chain = chain.then(createChildFromTemplate(witClient, service, currentWorkItem, template, teamSettings));
                                            });
                                            return chain;

                                        });
                                });
                        })
                })
        }

        function createChildFromTemplate(witClient, service, currentWorkItem, template, teamSettings) {
            return function () {
                return getTemplate(template.id).then(function (taskTemplate) {
                    // Create child
                    if (IsValidTemplateWIT(currentWorkItem, taskTemplate)) {
                        if (IsValidTemplateTitle(currentWorkItem, taskTemplate)) {
                            createWorkItem(service, currentWorkItem, taskTemplate, teamSettings)
                        }
                    }
                });
            };
        }

        function IsValidTemplateWIT(currentWorkItem, taskTemplate) {

            // We need to maintain backward compatibility with the original filtering approach using square brackets.
            // If not empty, does the description have the old square bracket approach or new JSON?
            var jsonFilters = extractJSON(taskTemplate.description)[0];

            if (IsJsonString(JSON.stringify(jsonFilters))) {
                // example JSON:
                //
                //   {
                //      "applywhen": [
                //        {
                //          "System.State": "Approved",
                //          "System.Tags" : ["Blah", "ClickMe"],
                //          "System.WorkItemType": "Product Backlog Item"
                //        },
                //        {
                //          "System.BoardColumn": "Testing",
                //          "System.BoardLane": "Off radar",
                //          "System.State": "Custom State",
                //          "System.Title": "Repeatable item",
                //          "System.WorkItemType": "Custom Type"
                //        }
                //      ]
                //    }

                // Match work item type if present, otherwise assume the first record without a work item type applies.
                var hasWorkItemType = jsonFilters.applywhen.filter(
                    function (el) {
                        return (el['System.WorkItemType'] !== "undefined");
                    }
                );

                var applicableFilter = jsonFilters.applywhen.filter(
                    function (el) {
                        return (
                            matchField('System.BoardColumn', currentWorkItem, el) &&
                            matchField('System.BoardLane', currentWorkItem, el) &&
                            matchField('System.State', currentWorkItem, el) &&
                            matchField('System.Tags', currentWorkItem, el) &&
                            matchField('System.Title', currentWorkItem, el) &&
                            (hasWorkItemType.length > 0 ? matchField('System.WorkItemType', currentWorkItem, el) : true)
                        );
                    }
                );

                return applicableFilter.length > 0;
            } else {
                var filters = taskTemplate.description.match(/[^[\]]+(?=])/g);

                if (filters) {
                    var isValid = false;
                    for (var i = 0; i < filters.length; i++) {
                        var found = filters[i].split(',').find(function (f) { return f.trim().toLowerCase() == currentWorkItem["System.WorkItemType"].toLowerCase() });
                        if (found) {
                            isValid = true;
                            break;
                        }
                    }
                    return isValid;
                } else {
                    return true;
                }
            }
        }

        function IsValidTemplateTitle(currentWorkItem, taskTemplate) {
            var jsonFilters = extractJSON(taskTemplate.description)[0];
            var isJSON = IsJsonString(JSON.stringify(jsonFilters));
            if (isJSON) {
                return true;
            }
            var filters = taskTemplate.description.match(/[^{\}]+(?=})/g);
            var curTitle = currentWorkItem["System.Title"].match(/[^{\}]+(?=})/g);
            if (filters) {
                var isValid = false;
                if (curTitle) {
                    for (var i = 0; i < filters.length; i++) {
                        if (curTitle.indexOf(filters[i]) > -1) {
                            isValid = true;
                            break;
                        }
                    }

                }
                return isValid;
            } else {
                return true;
            }

        }

        function findWorkTypeCategory(categories, workItemType) {
            for (category of categories) {
                var found = category.workItemTypes.find(function (w) { return w.name == workItemType; });
                if (found != null) {
                    return category;
                }
            }
        }

        function GetChildTypes(witClient, workItemType) {

            return witClient.getWorkItemTypeCategories(VSS.getWebContext().project.name)
                .then(function (response) {
                    var categories = response;
                    var category = findWorkTypeCategory(categories, workItemType);

                    if (category !== null) {
                        var requests = [];
                        var workClient = workRestClient.getClient();

                        var team = {
                            projectId: ctx.project.id,
                            teamId: ctx.team.id
                        };

                        bugsBehavior = workClient.getTeamSettings(team).bugsBehavior; //Off, AsTasks, AsRequirements

                        if (category.referenceName === 'Microsoft.EpicCategory') {
                            return witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.FeatureCategory')
                                .then(function (response) {
                                    var category = response;

                                    return category.workItemTypes.map(function (item) { return item.name; });
                                });
                        } else if (category.referenceName === 'Microsoft.FeatureCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.RequirementCategory'));
                            if (bugsBehavior === 'AsRequirements') { requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.RequirementCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                            if (bugsBehavior === 'AsTasks') { requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.BugCategory')); }
                        } else if (category.referenceName === 'Microsoft.BugCategory' && bugsBehavior === 'AsRequirements') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        } else if (category.referenceName === 'Microsoft.TaskCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        } else if (category.referenceName == 'Microsoft.BugCategory') {
                            requests.push(witClient.getWorkItemTypeCategory(VSS.getWebContext().project.name, 'Microsoft.TaskCategory'));
                        }

                        return Q.all(requests)
                            .then(function (response) {
                                var categories = response;

                                var result = [];
                                categories.forEach(function (category) {
                                    category.workItemTypes.forEach(function (workItemType) {
                                        result.push(workItemType.name);
                                    });
                                });

                                return result;
                            });
                    }
                });
        }

        function ShowDialog(message) {

            var dialogOptions = {
                title: "1-Click Child-Links",
                width: 300,
                height: 200,
                resizable: false,
            };

            VSS.getService(VSS.ServiceIds.Dialog).then(function (dialogSvc) {

                dialogSvc.openMessageDialog(message, dialogOptions)
                    .then(function (dialog) {
                        //
                    }, function (dialog) {
                        //
                    });
            });
        }

        function SortTemplates(a, b) {
            var nameA = a.name.toLowerCase(), nameB = b.name.toLowerCase();
            if (nameA < nameB) //sort string ascending
                return -1;
            if (nameA > nameB)
                return 1;
            return 0; //default return value (no sorting)
        }

        function WriteLog(msg) {
            console.log('1-Click Child-Links: ' + msg);
        }

        function extractJSON(str) {
            var firstOpen, firstClose, candidate;
            firstOpen = str.indexOf('{', firstOpen + 1);
            //console.log('firstopen: ', firstOpen);
            if (firstOpen != -1) {
                do {
                    firstClose = str.lastIndexOf('}');
                    //console.log('firstOpen: ' + firstOpen, 'firstClose: ' + firstClose);
                    if (firstClose <= firstOpen) {
                        return null;
                    }
                    do {
                        candidate = str.substring(firstOpen, firstClose + 1);
                        //console.log('candidate: ' + candidate);
                        try {
                            var res = JSON.parse(candidate);
                            //console.log('...found');
                            return [res, firstOpen, firstClose + 1];
                        }
                        catch (e) {
                            console.log('...failed');
                        }
                        firstClose = str.substr(0, firstClose).lastIndexOf('}');
                    } while (firstClose > firstOpen);
                    firstOpen = str.indexOf('{', firstOpen + 1);
                } while (firstOpen != -1);
            } else { return ''; }
        }

        function IsJsonString(str) {
            try {
                JSON.parse(str);
            } catch (e) {
                return false;
            }
            return true;
        }

        function matchField(fieldName, currentWorkItem, filterElement) {
            return (
                typeof (filterElement[fieldName]) === "undefined" ||
                (!Array.isArray(filterElement[fieldName].toLowerCase()) && filterElement[fieldName].toLowerCase() === currentWorkItem[fieldName].toLowerCase()) ||
                (Array.isArray(filterElement[fieldName].toLowerCase()) && arraysEqual(filterElement[fieldName], currentWorkItem[fieldName]))
            );
        }

        function arraysEqual(a, b) {
            if (a === b) return true;
            if (a == null || b == null) return false;
            if (a.length != b.length) return false;

            // If you don't care about the order of the elements inside
            // the array, you should sort both arrays here.
            // Please note that calling sort on an array will modify that array.
            // you might want to clone your array first.

            for (var i = 0; i < a.length; ++i) {
                if (a[i] !== b[i]) return false;
            }
            return true;
        }

        return {

            create: function (context) {
                WriteLog('init');

                ctx = VSS.getWebContext();

                getWorkItemFormService().then(function (service) {
                    service.hasActiveWorkItem()
                        .then(function success(response) {
                            if (response == true) {
                                //form is open
                                AddTasksOnForm(service);
                            }
                            else {
                                // on grid
                                if (context.workItemIds && context.workItemIds.length > 0) {

                                    context.workItemIds.forEach(function (workItemId) {
                                        AddTasksOnGrid(workItemId);
                                    });
                                }
                                else if (context.id) {
                                    var workItemId = context.id;
                                    AddTasksOnGrid(workItemId);
                                }
                            }
                        });
                })
            },
        }
    });